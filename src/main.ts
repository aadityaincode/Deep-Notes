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
import { BM25Index } from "./bm25";
import { deepNotesHighlightField } from "./highlights";
import { GeminiCacheManager } from "./ai";

export default class DeepNotesPlugin extends Plugin {
	settings: DeepNotesSettings = DEFAULT_SETTINGS;
	vectorStore!: VaultVectorStore;
	indexer!: VaultIndexer;
	bm25Index!: BM25Index;
	geminiCacheManager!: GeminiCacheManager;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Initialize vector store
		const pluginDir = this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
		this.vectorStore = new VaultVectorStore(this.app.vault.adapter, pluginDir);
		this.bm25Index = new BM25Index();
		this.geminiCacheManager = new GeminiCacheManager();
		await this.vectorStore.initialize();
		this.indexer = new VaultIndexer(this, this.vectorStore, this.bm25Index);
		if (this.settings.bm25AutoWarm) {
			setTimeout(() => { void this.indexer.warmBM25Index(); }, 3000);
		}

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
					this.bm25Index.removeDocument(file.path);
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
