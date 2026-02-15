import { Plugin, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_DEEP_NOTES } from "./constants";
import {
	DeepNotesSettings,
	DEFAULT_SETTINGS,
	DeepNotesSettingTab,
} from "./settings";
import { DeepNotesView } from "./view";

export default class DeepNotesPlugin extends Plugin {
	settings: DeepNotesSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

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
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
