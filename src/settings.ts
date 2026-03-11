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

		new Setting(containerEl).setName("Deep Notes settings").setHeading();

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
				   .setName("Google Gemini API key")
				   .setDesc("Your Google AI / Gemini API key")
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

		   // System prompt is now hidden from the settings UI for simplicity and safety.

		new Setting(containerEl).setName("Image scanning").setHeading();

		new Setting(containerEl)
			.setName("Vision provider")
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
				.setName("Gemini vision model")
				.setDesc("Using 'gemini-2.0-flash' for vision tasks.")
				.addText((text) => text.setValue("gemini-2.0-flash").setDisabled(true));

			// Ensure Gemini key is visible if not already shown in main provider
			if (this.plugin.settings.provider !== "gemini") {
				new Setting(containerEl)
					.setName("Gemini API key (for vision)")
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
		new Setting(containerEl).setName("Cross-topic search (embeddings)").setHeading();

		// Warning about changing providers
		const warningDiv = containerEl.createDiv({ cls: "deep-notes-setting-warning deep-notes-setting-warning-text" });
		warningDiv.setText("⚠️ IMPORTANT: If you change the embedding provider or model, you MUST run the 'Clear Semantic Search Index' command and re-index your vault. Otherwise, search will fail.");

		new Setting(containerEl)
			.setName("Embedding provider")
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
				.setName("Gemini embedding model")
				.setDesc("Uses 'gemini-embedding-001' (768 dimensions). Requires API key.")
				.addText((text) => text.setValue("gemini-embedding-001").setDisabled(true));

			if (!this.plugin.settings.geminiApiKey) {
				const w = containerEl.createDiv({ cls: "deep-notes-setting-warning deep-notes-setting-warning-text" });
				w.setText("⚠️ Gemini API Key is required. Please set it under 'AI Provider' (temporarily switch if needed) or check if you have separate keys logic.");
			}
		} else {
			// Ollama
			new Setting(containerEl)
				.setName("Ollama embedding model")
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
				.setName("Ollama base URL")
				.setDesc("Re-uses the base URL set above.")
				.addText((text) => text.setValue(this.plugin.settings.ollamaBaseUrl).setDisabled(true));
		}

		if (this.plugin.settings.embeddingProvider === "gemini" && this.plugin.settings.provider !== "gemini") {
			new Setting(containerEl)
				.setName("Gemini API key (for embeddings)")
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
