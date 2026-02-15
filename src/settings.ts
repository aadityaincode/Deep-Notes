import { App, PluginSettingTab, Setting } from "obsidian";
import {
	AIProvider,
	PROVIDERS,
	MODELS_BY_PROVIDER,
	DEFAULT_MODEL_BY_PROVIDER,
	DEFAULT_SYSTEM_PROMPT,
} from "./constants";
import type SocraticSagePlugin from "./main";

export interface SocraticSageSettings {
	provider: AIProvider;
	apiKey: string;
	anthropicApiKey: string;
	geminiApiKey: string;
	model: string;
	systemPrompt: string;
}

export const DEFAULT_SETTINGS: SocraticSageSettings = {
	provider: "openai",
	apiKey: "",
	anthropicApiKey: "",
	geminiApiKey: "",
	model: "gpt-4o-mini",
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
};

export class SocraticSageSettingTab extends PluginSettingTab {
	plugin: SocraticSagePlugin;

	constructor(app: App, plugin: SocraticSagePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Socratic Sage Settings" });

		// Provider selection
		new Setting(containerEl)
			.setName("AI Provider")
			.setDesc("Choose which AI provider to use.")
			.addDropdown((dropdown) => {
				for (const p of PROVIDERS) {
					dropdown.addOption(p.value, p.label);
				}
				dropdown
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						const provider = value as AIProvider;
						this.plugin.settings.provider = provider;
						this.plugin.settings.model =
							DEFAULT_MODEL_BY_PROVIDER[provider];
						await this.plugin.saveSettings();
						this.display(); // re-render to update model list & key field
					});
			});

		// API key for current provider
		const provider = this.plugin.settings.provider;
		const keyInfo = {
			openai: {
				name: "OpenAI API Key",
				desc: "Your OpenAI API key (sk-...)",
				placeholder: "sk-...",
				field: "apiKey" as const,
			},
			anthropic: {
				name: "Anthropic API Key",
				desc: "Your Anthropic API key (sk-ant-...)",
				placeholder: "sk-ant-...",
				field: "anthropicApiKey" as const,
			},
			gemini: {
				name: "Google Gemini API Key",
				desc: "Your Google AI / Gemini API key",
				placeholder: "AI...",
				field: "geminiApiKey" as const,
			},
		}[provider];

		new Setting(containerEl)
			.setName(keyInfo.name)
			.setDesc(keyInfo.desc)
			.addText((text) =>
				text
					.setPlaceholder(keyInfo.placeholder)
					.setValue(this.plugin.settings[keyInfo.field])
					.then((t) => (t.inputEl.type = "password"))
					.onChange(async (value) => {
						this.plugin.settings[keyInfo.field] = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// Model dropdown (filtered by provider)
		const models = MODELS_BY_PROVIDER[provider];
		new Setting(containerEl)
			.setName("Model")
			.setDesc(`Model to use with ${PROVIDERS.find((p) => p.value === provider)?.label}.`)
			.addDropdown((dropdown) => {
				for (const m of models) {
					dropdown.addOption(m, m);
				}
				dropdown
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value;
						await this.plugin.saveSettings();
					});
			});

		// System prompt
		new Setting(containerEl)
			.setName("System Prompt")
			.setDesc("Instructions sent to the AI for generating questions.")
			.addTextArea((text) =>
				text
					.setPlaceholder("Enter system prompt...")
					.setValue(this.plugin.settings.systemPrompt)
					.then((t) => {
						t.inputEl.rows = 10;
						t.inputEl.cols = 50;
					})
					.onChange(async (value) => {
						this.plugin.settings.systemPrompt = value;
						await this.plugin.saveSettings();
					})
			);

	}
}
