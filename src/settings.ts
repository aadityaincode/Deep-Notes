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


export type DeepNotesStudyMode = "socratic" | "active-recall" | "feynman" | "flashcard";

export interface DeepNotesSettings {
	provider: AIProvider;
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
	studyMode: DeepNotesStudyMode;
	bm25AutoWarm: boolean;
}


export const DEFAULT_SETTINGS: DeepNotesSettings = {
	provider: "gemini",
	geminiApiKey: "",
	ollamaBaseUrl: "http://127.0.0.1:11434",
	model: "gemini-2.0-flash",
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
	studyMode: "socratic",
	bm25AutoWarm: true,
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

		new Setting(containerEl).setName("Study mode").setHeading();

		new Setting(containerEl)
			.setName("Study mode")
			.setDesc("Choose how questions are generated for your notes.")
			.addDropdown((dropdown) => {
				dropdown.addOption("socratic", "Socratic depth");
				dropdown.addOption("active-recall", "Active recall (MCQ)");
				dropdown.addOption("feynman", "Feynman explainer");
				dropdown.addOption("flashcard", "Flashcard deck");
				dropdown
					.setValue(this.plugin.settings.studyMode)
					.onChange(async (value) => {
						this.plugin.settings.studyMode = value as DeepNotesStudyMode;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl).setName("AI provider").setHeading();

		// --- AI Provider ---
		new Setting(containerEl)
			.setName("AI provider")
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
		if (provider === "gemini") {
			new Setting(containerEl)
				.setName("Gemini API key")
				.setDesc("Gemini API key")
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
		} else if (provider === "ollama") {
			new Setting(containerEl)
				.setName("Ollama")
				.setDesc("Runs locally and does not require an API key.");

			new Setting(containerEl)
				.setName("Ollama base URL")
				.setDesc("Local server URL")
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

		// System prompt is now hidden from the settings UI for simplicity and safety.

		new Setting(containerEl).setName("Image scanning").setHeading();

		new Setting(containerEl)
			.setName("Vision provider")
			.setDesc("Choose which provider to use for scanning images.")
			.addDropdown((dropdown) => {
				dropdown.addOption("ollama", "Ollama");
				dropdown.addOption("gemini", "Gemini");
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
				.setName("Gemini vision model")
				.setDesc("Fixed model for vision tasks")
				.addText((text) => text.setValue("gemini-2.0-flash").setDisabled(true));

			// Ensure Gemini key is visible if not already shown in main provider
			if (this.plugin.settings.provider !== "gemini") {
				new Setting(containerEl)
					.setName("API key (for vision)")
					.setDesc("Required for vision.")
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
				.setDesc("Model to use for image scanning")
				.addText((text) =>
					text
						.setPlaceholder("Enter model name")
						.setValue(this.plugin.settings.imageOcrVisionModel)
						.onChange(async (value) => {
							this.plugin.settings.imageOcrVisionModel = value.trim() || "llava:latest";
							await this.plugin.saveSettings();
						})
				);

			const scanInfo = containerEl.createDiv({ cls: "deep-notes-setting-warning" });
			scanInfo.setText("Image scanning sends images to your AI model. Pull a vision model first.");
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
		new Setting(containerEl).setName("Cross-topic search").setHeading();

		new Setting(containerEl)
			.setName("Auto-warm BM25 index on startup")
			.setDesc("Index all vault files for keyword search when Obsidian loads. Disable to reduce startup file enumeration.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.bm25AutoWarm)
					.onChange(async (value) => {
						this.plugin.settings.bm25AutoWarm = value;
						await this.plugin.saveSettings();
					})
			);

		// Warning about changing providers
		const warningDiv = containerEl.createDiv({ cls: "deep-notes-setting-warning deep-notes-setting-warning-text" });
		warningDiv.setText("Changing the embedding provider or model requires clearing and re-indexing.");

		new Setting(containerEl)
			.setName("Embedding provider")
			.setDesc("Choose which provider to use for embeddings.")
			.addDropdown((dropdown) => {
				dropdown.addOption("gemini", "Gemini (768d)");
				dropdown.addOption("ollama", "Ollama");
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
				.setName("Gemini embedding model")
				.setDesc("Fixed model for text embeddings (768 dimensions)")
				.addText((text) => text.setValue("gemini-embedding-001").setDisabled(true));

			if (!this.plugin.settings.geminiApiKey) {
				const w = containerEl.createDiv({ cls: "deep-notes-setting-warning deep-notes-setting-warning-text" });
				w.setText("Gemini API key is required. Set it under the provider section.");
			}
		} else {
			// Ollama
			new Setting(containerEl)
				.setName("Ollama embedding model")
				.setDesc("Model to use for embeddings")
				.addText((text) =>
					text
						.setPlaceholder("Enter model name")
						.setValue(this.plugin.settings.ollamaEmbeddingModel)
						.onChange(async (value) => {
							this.plugin.settings.ollamaEmbeddingModel = value.trim();
							await this.plugin.saveSettings();
						})
				);

			new Setting(containerEl)
				.setName("Ollama base URL")
				.setDesc("Re-uses the base URL set above.")
				.addText((text) => text.setValue(this.plugin.settings.ollamaBaseUrl).setDisabled(true));
		}

		if (this.plugin.settings.embeddingProvider === "gemini" && this.plugin.settings.provider !== "gemini") {
			new Setting(containerEl)
				.setName("API key (for embeddings)")
				.setDesc("Required for embeddings.")
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
