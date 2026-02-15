import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import {
	AIProvider,
	PROVIDERS,
	MODELS_BY_PROVIDER,
	DEFAULT_MODEL_BY_PROVIDER,
	DEFAULT_SYSTEM_PROMPT,
} from "./constants";
import type { EmbeddingProvider } from "./embeddings";
import type { QASession } from "./history";
import type DeepNotesPlugin from "./main";

export interface DeepNotesSettings {
	provider: AIProvider;
	apiKey: string;
	anthropicApiKey: string;
	geminiApiKey: string;
	ollamaBaseUrl: string; 
	model: string;
	imageOcrEnabled: boolean;
	imageOcrVisionModel: string;
	imageOcrMaxImages: number;
	imageOnlyMode: boolean;
	ocrDebugEnabled: boolean;
	systemPrompt: string;
	embeddingProvider: EmbeddingProvider;
	ollamaEmbeddingModel: string;
	history: QASession[];
}

export const DEFAULT_SETTINGS: DeepNotesSettings = {
	provider: "openai",
	apiKey: "",
	anthropicApiKey: "",
	geminiApiKey: "",
	ollamaBaseUrl: "http://127.0.0.1:11434",
	model: "gpt-4o-mini",
	imageOcrEnabled: false,
	imageOcrVisionModel: "llava:latest",
	imageOcrMaxImages: 5,
	imageOnlyMode: false,
	ocrDebugEnabled: false,
	systemPrompt: DEFAULT_SYSTEM_PROMPT,
	embeddingProvider: "gemini",
	ollamaEmbeddingModel: "nomic-embed-text",
	history: [],
};

export class DeepNotesSettingTab extends PluginSettingTab {
	plugin: DeepNotesPlugin;

	constructor(app: App, plugin: DeepNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Deep Notes Settings" });

		// --- AI Provider ---
		new Setting(containerEl)
			.setName("AI Provider")
			.setDesc("Choose which AI provider to use for generation.")
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
						this.display();
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
		};

		if (provider !== "ollama") {
			const providerKeyInfo = keyInfo[provider];
			new Setting(containerEl)
				.setName(providerKeyInfo.name)
				.setDesc(providerKeyInfo.desc)
				.addText((text) =>
					text
						.setPlaceholder(providerKeyInfo.placeholder)
						.setValue(this.plugin.settings[providerKeyInfo.field])
						.then((t) => (t.inputEl.type = "password"))
						.onChange(async (value) => {
							this.plugin.settings[providerKeyInfo.field] = value.trim();
							await this.plugin.saveSettings();
						})
				);
		} else {
			new Setting(containerEl)
				.setName("Ollama")
				.setDesc("Runs locally and does not require an API key.");

			new Setting(containerEl)
				.setName("Ollama Base URL")
				.setDesc("Local Ollama server URL.")
				.addText((text) =>
					text
						.setPlaceholder("http://127.0.0.1:11434")
						.setValue(this.plugin.settings.ollamaBaseUrl)
						.onChange(async (value) => {
							this.plugin.settings.ollamaBaseUrl = value.trim() || "http://127.0.0.1:11434";
							await this.plugin.saveSettings();
						})
				);
		}

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

		containerEl.createEl("h2", { text: "Image Scanning" });

		new Setting(containerEl)
			.setName("Vision model")
			.setDesc("Ollama vision model for image scanning (e.g. llava:latest). Only used with the 'Scan Images' button.")
			.addText((text) =>
				text
					.setPlaceholder("llava:latest")
					.setValue(this.plugin.settings.imageOcrVisionModel)
					.onChange(async (value) => {
						this.plugin.settings.imageOcrVisionModel = value.trim() || "llava:latest";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Max images per scan")
			.setDesc("Maximum number of images to process when scanning.")
			.addSlider((slider) =>
				slider
					.setLimits(1, 20, 1)
					.setValue(this.plugin.settings.imageOcrMaxImages)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.imageOcrMaxImages = value;
						await this.plugin.saveSettings();
					})
			);

		const scanInfo = containerEl.createDiv({ cls: "deep-notes-setting-warning" });
		scanInfo.setText("Image scanning sends embedded images directly to your AI model. For Ollama, pull a vision model first: ollama pull llava:latest");

		// --- Cross-Topic Search (Embeddings) ---
		containerEl.createEl("h2", { text: "Cross-Topic Search (Embeddings)" });

		// Warning about changing providers
		const warningDiv = containerEl.createDiv({ cls: "deep-notes-setting-warning" });
		warningDiv.setText("⚠️ IMPORTANT: If you change the embedding provider or model, you MUST run the 'Clear Semantic Search Index' command and re-index your vault. Otherwise, search will fail.");
		warningDiv.style.color = "var(--text-error)";
		warningDiv.style.marginBottom = "10px";
		warningDiv.style.fontSize = "0.9em";

		new Setting(containerEl)
			.setName("Embedding Provider")
			.setDesc("Choose which provider to use for embeddings.")
			.addDropdown((dropdown) => {
				dropdown.addOption("gemini", "Google Gemini (768d)");
				dropdown.addOption("ollama", "Ollama (Local)");
				dropdown
					.setValue(this.plugin.settings.embeddingProvider)
					.onChange(async (value) => {
						this.plugin.settings.embeddingProvider = value as EmbeddingProvider;
						await this.plugin.saveSettings();
						this.display(); // Re-render to show/hide options
						new Notice("Provider changed. Please clear and re-index your vault.");
					});
			});

		if (this.plugin.settings.embeddingProvider === "gemini") {
			new Setting(containerEl)
				.setName("Gemini Embedding Model")
				.setDesc("Uses 'gemini-embedding-001' (768 dimensions). Requires API Key.")
				.addText((text) => text.setValue("gemini-embedding-001").setDisabled(true));

			if (!this.plugin.settings.geminiApiKey) {
				const w = containerEl.createDiv({ cls: "deep-notes-setting-warning" });
				w.setText("⚠️ Gemini API Key is required. Please set it under 'AI Provider' (temporarily switch if needed) or check if you have separate keys logic.");
				w.style.color = "var(--text-error)";
				// Ideally we should allow setting Gemini key here if provider != Gemini
				// But simplified for now: assume user sets key in main provider section if using Gemini there.
				// Or better: Add a separate Gemini Key field if embedding is Gemini but main provider is NOT Gemini?
				// The current settings.ts only shows Gemini Key field if main provider IS Gemini.
				// FIX: Look at main provider key logic below.
			}
		} else {
			// Ollama
			new Setting(containerEl)
				.setName("Ollama Embedding Model")
				.setDesc("Name of the Ollama model to use for embeddings (e.g., 'nomic-embed-text', 'mxbai-embed-large'). Ensure you have pulled this model (`ollama pull <model>`).")
				.addText((text) =>
					text
						.setPlaceholder("nomic-embed-text")
						.setValue(this.plugin.settings.ollamaEmbeddingModel)
						.onChange(async (value) => {
							this.plugin.settings.ollamaEmbeddingModel = value.trim();
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("Ollama Base URL")
				.setDesc("Re-uses the Base URL set above.")
				.addText((text) => text.setValue(this.plugin.settings.ollamaBaseUrl).setDisabled(true));
		}

		// Logic to ensure Gemini API key is visible/set-able if Embedding Provider is Gemini
		// Current logic: only shows key field if MAIN provider is Gemini.
		// I should ALWAYS show Gemini Key field if EITHER main provider OR embedding provider is Gemini?
		// Or add a dedicated "Gemini Embeddings Key" field if strictly needed?
		// Let's modify the top loop to show Gemini key if needed.
		// Actually, user can switch to Gemini, set key, switch back to OpenAI. The key persists in settings.
		// But the UI hides it.
		// I'll add a check: if embeddingProvider is Gemini, and main provider is NOT Gemini, show Gemini Key field here.

		if (this.plugin.settings.embeddingProvider === "gemini" && this.plugin.settings.provider !== "gemini") {
			new Setting(containerEl)
				.setName("Gemini API Key (for Embeddings)")
				.setDesc("Required for Gemini embeddings.")
				.addText((text) =>
					text
						.setPlaceholder("AI...")
						.setValue(this.plugin.settings.geminiApiKey)
						.then((t) => (t.inputEl.type = "password"))
						.onChange(async (value) => {
							this.plugin.settings.geminiApiKey = value.trim();
							await this.plugin.saveSettings();
						})
				);
		}
	}
}
