import { Plugin, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE_SOCRATIC } from "./constants";
import {
	SocraticSageSettings,
	DEFAULT_SETTINGS,
	SocraticSageSettingTab,
} from "./settings";
import { SocraticSageView } from "./view";

export default class SocraticSagePlugin extends Plugin {
	settings: SocraticSageSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_SOCRATIC, (leaf) => new SocraticSageView(leaf, this));

		this.addRibbonIcon("message-circle-question", "Socratic Sage", () => {
			this.activateView();
		});

		this.addCommand({
			id: "open-socratic-sage",
			name: "Open Socratic Sage",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "generate-socratic-questions",
			name: "Generate Socratic Questions",
			callback: async () => {
				const view = await this.activateView();
				if (view) {
					view.triggerGeneration();
				}
			},
		});

		this.addSettingTab(new SocraticSageSettingTab(this.app, this));
	}

	onunload(): void {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_SOCRATIC);
	}

	async activateView(): Promise<SocraticSageView | null> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_SOCRATIC)[0];

		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (!rightLeaf) return null;
			leaf = rightLeaf;
			await leaf.setViewState({
				type: VIEW_TYPE_SOCRATIC,
				active: true,
			});
		}

		workspace.revealLeaf(leaf);
		return leaf.view as SocraticSageView;
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
