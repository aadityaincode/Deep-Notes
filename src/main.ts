import { Plugin, TFile, debounce, Notice } from "obsidian";
import { VIEW_TYPE_DEEP_NOTES } from "./constants";
import {
	DeepNotesSettings,
	DEFAULT_SETTINGS,
	DeepNotesSettingTab,
} from "./settings";
import { DeepNotesView } from "./view";
import { VaultVectorStore } from "./vectorStore";
import { VaultIndexer } from "./indexer";
import { deepNotesHighlightField } from "./highlights";

export default class DeepNotesPlugin extends Plugin {
	settings: DeepNotesSettings = DEFAULT_SETTINGS;
	vectorStore!: VaultVectorStore;
	indexer!: VaultIndexer;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Initialize vector store
		const pluginDir = this.manifest.dir;
		const adapter = this.app.vault.adapter;
		const vaultBasePath = "getBasePath" in adapter
			? (adapter as { getBasePath(): string }).getBasePath()
			: "";
		const fullPluginDir = `${vaultBasePath}/${pluginDir}`;
		this.vectorStore = new VaultVectorStore(fullPluginDir);
		await this.vectorStore.initialize();
		this.indexer = new VaultIndexer(this, this.vectorStore);

		this.registerView(VIEW_TYPE_DEEP_NOTES, (leaf) => new DeepNotesView(leaf, this));

		this.addRibbonIcon("triangle", "Open deep notes", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-view",
			name: "Open view",
			callback: () => { void this.activateView(); },
		});

		this.addCommand({
			id: "check-similar-notes",
			name: "Check similar notes for current file (debug)",
			callback: async () => {
				const file = this.app.workspace.getActiveFile();
				if (!file) {
					new Notice("No active file.");
					return;
				}

				try {
					new Notice(`Checking similarity for ${file.basename}...`);
					const content = await this.app.vault.read(file);
					const { getEmbedding } = await import("./embeddings");
					const embedding = await getEmbedding(content, this.settings);

					if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
						new Notice("Embedding failed (empty or invalid).");
						console.error("[DeepNotes] Invalid embedding:", embedding);
						return;
					}

					console.debug(`[DeepNotes] Searching with embedding (dim: ${embedding.length})`);
					const results = await this.vectorStore.search(embedding, 5, file.path);

					if (results.length === 0) {
						new Notice("No similar notes found (score > 0).");
					} else {
						const msg = results.map(r => `${r.noteTitle} (${(r.score).toFixed(4)})`).join("\n");
						new Notice(`Top matches:\n${msg}`, 5000);
						console.debug("[DeepNotes] Similarity Results:", results);
					}
				} catch (e) {
					new Notice(`Error checking similarity: ${e}`);
					console.error(e);
				}
			},
		});

		this.addCommand({
			id: "generate-questions",
			name: "Generate questions",
			callback: async () => {
				const view = await this.activateView();
				if (view) {
					void view.triggerGeneration();
				}
			},
		});


		this.addCommand({
			id: "index-vault",
			name: "Index vault for cross-topic search",
			callback: () => { void this.indexer.indexVault(); },
		});

		this.addCommand({
			id: "clear-index",
			name: "Clear semantic search index",
			callback: async () => {
				new Notice("Clearing vector index...");
				try {
					await this.vectorStore.clearIndex();
					new Notice("Index cleared. Please re-index vault.");
				} catch (e) {
					new Notice(`Failed to clear index: ${e}`);
				}
			},
		});

		this.addCommand({
			id: "show-index-stats",
			name: "Show semantic index stats (debug)",
			callback: async () => {
				try {
					const stats = await this.vectorStore.getStats();
					new Notice(`Index contains ${stats.totalChunks} chunks.`);
					console.debug("[DeepNotes] Index Stats:", stats);
				} catch (e) {
					new Notice(`Error getting stats: ${e}`);
				}
			},
		});

		// Incremental re-indexing on file modify
		this.registerEvent(
			this.app.vault.on(
				"modify",
				debounce((file) => {
					if (file instanceof TFile && file.extension === "md") {
						void this.indexer.indexSingleNote(file);
					}
				}, 5000)
			)
		);

		// Remove vectors for deleted notes from the index
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile && file.extension === "md") {
					void this.vectorStore.removeNote(file.path);
				}
			})
		);

		this.addSettingTab(new DeepNotesSettingTab(this.app, this));

		// Register CM6 editor extension for highlights
		this.registerEditorExtension(deepNotesHighlightField);
	}

	onunload(): void {
		// Obsidian handles leaf lifecycle — do not detach leaves here
	}

	async activateView(): Promise<DeepNotesView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_DEEP_NOTES)[0];

		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (!rightLeaf) return null;
			leaf = rightLeaf;
			await leaf.setViewState({
				type: VIEW_TYPE_DEEP_NOTES,
				active: true,
			});
		}

		void workspace.revealLeaf(leaf);
		return leaf.view as DeepNotesView;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<DeepNotesSettings>);
		// Always use the latest system prompt from code
		this.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
