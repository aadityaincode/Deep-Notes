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

export default class DeepNotesPlugin extends Plugin {
	settings: DeepNotesSettings = DEFAULT_SETTINGS;
	vectorStore!: VaultVectorStore;
	indexer!: VaultIndexer;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Initialize vector store
		const pluginDir = this.manifest.dir;
		const vaultBasePath = (this.app.vault.adapter as any).basePath;
		const fullPluginDir = `${vaultBasePath}/${pluginDir}`;
		this.vectorStore = new VaultVectorStore(fullPluginDir);
		await this.vectorStore.initialize();
		this.indexer = new VaultIndexer(this, this.vectorStore);

		this.registerView(VIEW_TYPE_DEEP_NOTES, (leaf) => new DeepNotesView(leaf, this));

		this.addRibbonIcon("book-open", "Deep Notes", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-deep-notes",
			name: "Open Deep Notes",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "check-similar-notes",
			name: "Check Similar Notes for Current File (Debug)",
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

					console.log(`[DeepNotes] Searching with embedding (dim: ${embedding.length})`);
					const results = await this.vectorStore.search(embedding, 5, file.path);

					if (results.length === 0) {
						new Notice("No similar notes found (score > 0).");
					} else {
						const msg = results.map(r => `${r.noteTitle} (${(r.score).toFixed(4)})`).join("\n");
						new Notice(`Top matches:\n${msg}`, 5000);
						console.log("[DeepNotes] Similarity Results:", results);
					}
				} catch (e) {
					new Notice(`Error checking similarity: ${e}`);
					console.error(e);
				}
			},
		});

		this.addCommand({
			id: "generate-deep-notes-questions",
			name: "Generate Deep Notes Questions",
			callback: async () => {
				const view = await this.activateView();
				if (view) {
					view.triggerGeneration();
				}
			},
		});


		this.addCommand({
			id: "index-vault",
			name: "Index Vault for Cross-Topic Search",
			callback: () => this.indexer.indexVault(),
		});

		this.addCommand({
			id: "clear-index",
			name: "Clear Semantic Search Index",
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
			name: "Show Semantic Index Stats (Debug)",
			callback: async () => {
				try {
					const stats = await this.vectorStore.getStats();
					new Notice(`Index contains ${stats.totalChunks} chunks.`);
					console.log("[DeepNotes] Index Stats:", stats);
				} catch (e) {
					new Notice(`Error getting stats: ${e}`);
				}
			},
		});

		// Incremental re-indexing on file modify
		this.registerEvent(
			this.app.vault.on(
				"modify",
				debounce((file: TFile) => {
					if (file.extension === "md") {
						this.indexer.indexSingleNote(file);
					}
				}, 5000)
			)
		);

		this.addSettingTab(new DeepNotesSettingTab(this.app, this));
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_DEEP_NOTES);
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

		workspace.revealLeaf(leaf);
		return leaf.view as DeepNotesView;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Always use the latest system prompt from code
		this.settings.systemPrompt = DEFAULT_SETTINGS.systemPrompt;
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
