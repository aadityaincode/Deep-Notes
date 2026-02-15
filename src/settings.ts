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
	imageOcrProvider: "ollama" | "gemini";
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
	imageOcrProvider: "ollama",
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
			.setName("Vision Provider")
			.setDesc("Choose which provider to use for scanning images.")
			.addDropdown((dropdown) => {
				dropdown.addOption("ollama", "Ollama (Local)");
				dropdown.addOption("gemini", "Google Gemini");
				dropdown
					.setValue(this.plugin.settings.imageOcrProvider || "ollama")
					.onChange(async (value) => {
						this.plugin.settings.imageOcrProvider = value as "ollama" | "gemini";
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.imageOcrProvider === "gemini") {
			new Setting(containerEl)
				.setName("Gemini Vision Model")
				.setDesc("Using 'gemini-2.0-flash' for vision tasks.")
				.addText((text) => text.setValue("gemini-2.0-flash").setDisabled(true));

			// Ensure Gemini key is visible if not already shown in main provider
			if (this.plugin.settings.provider !== "gemini") {
				new Setting(containerEl)
					.setName("Gemini API Key (for Vision)")
					.setDesc("Required for Gemini vision.")
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
		} else {
			// Ollama
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

			const scanInfo = containerEl.createDiv({ cls: "deep-notes-setting-warning" });
			scanInfo.setText("Image scanning sends embedded images directly to your AI model. For Ollama, pull a vision model first: ollama pull llava:latest");
		}

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
		// AND Main provider is NOT Gemini AND Vision Provider is NOT Gemini (since we add logic for that above too)
		// Basically: If any Gemini feature is on, show the key field if not already shown.
		// My logic above adds "Gemini API Key (for Vision)" if Vision is Gemini and Main != Gemini.
		// My logic below adds "Gemini API Key (for Embeddings)" if Embed is Gemini and Main != Gemini.
		// Issue: If I have BOTH Vision=Gemini and Embedding=Gemini and Main=OpenAI, I will show TWO key fields.
		// That's redundant.
		// Better: Check if Gemini Key field has ALREADY been rendered in this cycle?
		// No easy way to check.
		// Let's just be smart:
		// If Main=Gemini -> Key is at top. Done.
		// If Main!=Gemini:
		//    Check if Vision=Gemini OR Embedding=Gemini. If so, show "Gemini API Key" once?
		//    But they are in different sections (Image Scanning vs Embeddings).
		//    It's okay to show it in the specific section where it's needed, for clarity.
		//    "Gemini API Key (for Vision)" and "Gemini API Key (for Embeddings)" is fine.
		//    They bind to the same `settings.geminiApiKey`. So typing in one updates all.
		//    I'll keep it as is. It's user-friendly.

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
