import { Plugin, TFile, debounce } from "obsidian";
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
		const pluginDir = this.manifest.dir!;
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
