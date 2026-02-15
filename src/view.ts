import { ItemView, Notice, WorkspaceLeaf, TFile, debounce, setIcon } from "obsidian";
import { VIEW_TYPE_DEEP_NOTES, IMAGE_SCAN_SYSTEM_PROMPT, AIProvider } from "./constants";
import { generateDeepNotesQuestions, evaluateResponses, DeepNotesItem, EvaluationResult } from "./ai";
import { getEmbedding } from "./embeddings";
import { listEmbeddedImages, loadImagesByPaths, resolveExcalidrawEmbeddedImages, extractExcalidrawAnnotations, ImageInfo, ImagePayload } from "./ocr";
import { saveSession, getSessionsForNote, deleteSession, QASession } from "./history";
import { HIGHLIGHT_COLORS, applyHighlights, clearAllHighlights, scrollToExcerpt } from "./highlights";
import type DeepNotesPlugin from "./main";

type ViewMode = "questions" | "evaluation" | "history";

interface CachedSession {
	items: DeepNotesItem[];
	responses: string[];
	evaluationResult: EvaluationResult | null;
	viewMode: ViewMode;
}

// Global cache to persist state across view reloads/navigation
// Key: file path
const sessionCache = new Map<string, CachedSession>();

export class DeepNotesView extends ItemView {
	plugin: DeepNotesPlugin;
	private items: DeepNotesItem[] = [];
	private loading = false;
	private loadingMessage = "";
	private evaluating = false;
	private evaluationResult: EvaluationResult | null = null;
	private textareaRefs: HTMLTextAreaElement[] = [];
	private viewMode: ViewMode = "questions";
	private lastNotePath: string | null = null;
	private currentResponses: string[] = [];
	// Image picker state
	private showImagePicker = false;
	private availableImages: ImageInfo[] = [];
	private selectedImagePaths: Set<string> = new Set();

	constructor(leaf: WorkspaceLeaf, plugin: DeepNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_DEEP_NOTES;
	}

	getDisplayText(): string {
		return "Deep Notes";
	}

	getIcon(): string {
		return "book-open";
	}

	async onOpen(): Promise<void> {
		this.registerEvent(
			this.app.workspace.on(
				"active-leaf-change",
				debounce(async () => {
					await this.handleActiveLeafChange();
				}, 200)
			)
		);
		// Initial check
		await this.handleActiveLeafChange();
	}

	async onClose(): Promise<void> {
		this.saveCurrentStateToCache();
		// If we are closing, we should clear highlights from the last known path
		if (this.lastNotePath) {
			clearAllHighlights(this.app, this.lastNotePath);
		} else {
			clearAllHighlights(this.app);
		}
		this.contentEl.empty();
	}

	private saveCurrentStateToCache(): void {
		if (!this.lastNotePath) return;

		// Only save if there's something to save
		if (this.items.length > 0 || this.evaluationResult) {
			sessionCache.set(this.lastNotePath, {
				items: this.items,
				responses: this.currentResponses,
				evaluationResult: this.evaluationResult,
				viewMode: this.viewMode,
			});
		}
	}

	private async handleActiveLeafChange(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		const newPath = file ? file.path : null;

		// Ignore if same file — don't re-render when clicking between
		// the editor and sidebar, which also fires active-leaf-change
		if (newPath === this.lastNotePath) return;

		// If changing files, save state of the OLD file
		if (this.lastNotePath) {
			this.saveCurrentStateToCache();
			clearAllHighlights(this.app, this.lastNotePath);
		}

		this.lastNotePath = newPath;

		if (!file) {
			this.items = [];
			this.evaluationResult = null;
			this.viewMode = "questions";
			this.render();
			return;
		}

		// Restore from cache if exists
		const cached = sessionCache.get(file.path);
		if (cached) {
			this.items = cached.items;
			this.evaluationResult = cached.evaluationResult;
			this.viewMode = cached.viewMode;
			this.currentResponses = cached.responses;
			// We'll restore responses after render
			this.render();
			// Restore responses
			if (this.viewMode === "questions") {
				// Wait for DOM
				requestAnimationFrame(() => {
					for (let i = 0; i < this.currentResponses.length && i < this.textareaRefs.length; i++) {
						this.textareaRefs[i].value = this.currentResponses[i];
					}
				});
			}
			// Re-apply highlights if we have items
			this.applyQuestionHighlights();
		} else {
			// New note with no history
			this.items = [];
			this.evaluationResult = null;
			this.currentResponses = [];
			this.viewMode = "questions";
			this.render();
		}
	}

	private applyQuestionHighlights(): void {
		if (this.items.length === 0) {
			clearAllHighlights(this.app, this.lastNotePath || undefined);
			return;
		}

		const excerpts = this.items
			.map((item, idx) => ({
				text: item.sourceExcerpt ?? "",
				colorIndex: idx,
			}))
			.filter((e) => e.text.length > 0);

		if (excerpts.length > 0) {
			// Small delay to let the editor settle after render
			setTimeout(() => applyHighlights(this.app, excerpts, this.lastNotePath || undefined), 100);
		}
	}

	private getActiveKey(): string {
		const { provider, apiKey, anthropicApiKey, geminiApiKey } = this.plugin.settings;
		return { openai: apiKey, anthropic: anthropicApiKey, gemini: geminiApiKey, ollama: "" }[provider];
	}

	async triggerGeneration(): Promise<void> {
		const { provider, model, systemPrompt, ollamaBaseUrl } = this.plugin.settings;
		const activeKey = this.getActiveKey();

		if (provider !== "ollama" && !activeKey) {
			new Notice("Please set your API key in Deep Notes settings.");
			return;
		}

		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active note to analyze.");
			return;
		}

		this.loading = true;
		this.loadingMessage = "Generating questions from note...";
		this.evaluationResult = null;
		this.textareaRefs = [];
		this.viewMode = "questions";
		this.render();

		try {
			const content = await this.app.vault.read(file);

			// Index just this note (fast), full vault indexing is done via command or on first use
			await this.plugin.indexer.indexSingleNote(file);
			let enrichedContent = content;

			// Search for related notes via vector store
			let relatedContext = undefined;
			try {
				const stats = await this.plugin.vectorStore.getStats();
				if (stats.totalChunks > 0) {
					const queryEmbedding = await getEmbedding(enrichedContent, this.plugin.settings);
					const results = await this.plugin.vectorStore.search(
						queryEmbedding,
						5,
						file.path
					);
					// Only include results for notes that still exist in the vault
					const existingFiles = new Set(
						this.app.vault.getMarkdownFiles().map((f) => f.path)
					);
					const validResults = results.filter((r) => existingFiles.has(r.filePath));
					console.log(`[DeepNotes] Related context found: ${validResults.length} items`, validResults);
					if (validResults.length > 0) {
						relatedContext = validResults;
					}
				} else {
					console.log("[DeepNotes] Vector store stats empty, skipping cross-topic search");
				}
			} catch (e) {
				console.warn("Cross-topic search failed, generating without context:", e);
			}

			this.items = await generateDeepNotesQuestions(
				enrichedContent,
				this.plugin.settings,
				systemPrompt,
				relatedContext
			);

			// Filter out cross-topic questions if no related notes were provided
			// (the LLM sometimes generates them anyway)
			if (!relatedContext) {
				this.items = this.items.filter((item) => item.type !== "cross-topic");
			}

			// Initialize responses
			this.currentResponses = new Array(this.items.length).fill("");

			// Save to cache immediately
			this.saveCurrentStateToCache();

		} catch (e) {
			new Notice(`Deep Notes error: ${e instanceof Error ? e.message : e}`);
			this.items = [];
		} finally {
			this.loading = false;
			this.render();
			this.applyQuestionHighlights();
		}
	}

	private openImagePicker(): void {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active note.");
			return;
		}

		const content = this.app.vault.getAbstractFileByPath(file.path);
		if (!content) return;

		// Read note content synchronously from cache if possible
		this.app.vault.read(file).then((noteContent) => {
			this.availableImages = listEmbeddedImages(
				this.app,
				file,
				noteContent
			);

			if (this.availableImages.length === 0) {
				new Notice("No images found in this note. Embed images with ![[image.png]] syntax.");
				return;
			}

			// Pre-select all images
			this.selectedImagePaths.clear();
			for (const img of this.availableImages) {
				this.selectedImagePaths.add(img.path);
			}
			this.showImagePicker = true;
			this.render();
		});
	}

	private async triggerImageScan(): Promise<void> {
		if (this.selectedImagePaths.size === 0) {
			new Notice("Select at least one image to scan.");
			return;
		}

		const { provider, model, ollamaBaseUrl, imageOcrProvider, geminiApiKey, imageOcrVisionModel } = this.plugin.settings;
		const activeKey = this.getActiveKey();

		// Check keys based on usage
		if (provider !== "ollama" && !activeKey) {
			new Notice("Please set your main API key in Deep Notes settings.");
			return;
		}

		// Check vision-specific key
		if (imageOcrProvider === "gemini" && !geminiApiKey) {
			new Notice("Gemini API Key is required for vision tasks.");
			return;
		}

		this.showImagePicker = false;
		this.loading = true;
		this.loadingMessage = `Loading ${this.selectedImagePaths.size} image(s)...`;
		this.evaluationResult = null;
		this.textareaRefs = [];
		this.render();

		try {
			// Read the note content for context
			const activeFile = this.app.workspace.getActiveFile();
			let noteContent = "";
			if (activeFile) {
				noteContent = await this.app.vault.read(activeFile);
			}

			// Separate raster images from excalidraw
			const selectedPaths = Array.from(this.selectedImagePaths);
			const rasterPaths = selectedPaths.filter((p) => {
				const info = this.availableImages.find((i) => i.path === p);
				return info && !info.isExcalidraw;
			});
			const excalidrawPaths = selectedPaths.filter((p) => {
				const info = this.availableImages.find((i) => i.path === p);
				return info && info.isExcalidraw;
			});

			// Load raster images
			const rasterPayloads = rasterPaths.length > 0
				? await loadImagesByPaths(this.app, rasterPaths)
				: [];

			// For Excalidraw: extract the actual embedded screenshots + text annotations
			let excalidrawImagePayloads: ImagePayload[] = [];
			let excalidrawAnnotations: string[] = [];
			if (excalidrawPaths.length > 0) {
				this.loadingMessage = `Extracting images from ${excalidrawPaths.length} drawing(s)...`;
				this.render();

				for (const ePath of excalidrawPaths) {
					// Load the actual embedded screenshots (PNGs/JPGs pasted into the drawing)
					const embeddedImages = await resolveExcalidrawEmbeddedImages(this.app, ePath);
					excalidrawImagePayloads.push(...embeddedImages);

					// Extract hand-drawn text annotations for context
					const annotations = await extractExcalidrawAnnotations(this.app, ePath);
					if (annotations.trim()) {
						excalidrawAnnotations.push(`[Annotations from ${ePath}]:\n${annotations}`);
					}
				}
			}

			// Merge all images
			const allImages = [...rasterPayloads, ...excalidrawImagePayloads];

			if (allImages.length === 0) {
				new Notice("No images found. Excalidraw drawings without embedded screenshots have no images to scan.");
				this.loading = false;
				this.render();
				return;
			}

			// Determine which model/provider to use for VISION
			const visionProvider = imageOcrProvider === "gemini" ? "gemini" : "ollama";
			const visionModelName = imageOcrProvider === "gemini" ? "gemini-2.0-flash" : (imageOcrVisionModel || "llava");
			const visionApiKey = imageOcrProvider === "gemini" ? geminiApiKey : "";

			this.loadingMessage = `Analyzing ${allImages.length} image(s) with ${visionModelName}...`;
			this.render();

			console.log(
				`[Deep Notes] Sending ${allImages.length} image(s) to ${visionProvider}/${visionModelName}:\n` +
				allImages.map((img, i) => `  [${i + 1}] ${img.path} (${img.mimeType}, ${img.bytes} bytes)`).join("\n")
			);

			// Build user message — images are PRIMARY, note + annotations are background context
			const annotationBlock = excalidrawAnnotations.length > 0
				? `\n\nHand-drawn annotations from the Excalidraw drawings (these are labels/notes the student wrote on top of the images):\n${excalidrawAnnotations.join("\n\n")}`
				: "";

			let userText = `FOCUS ON THE IMAGES. Generate questions about what the image(s) show — the diagrams, formulas, calculations, and visual content.${annotationBlock}

For background context only (do NOT generate questions about this text directly), here is the note this image belongs to:

${noteContent}`;

			// Create synthetic settings for vision generation
			const visionSettings = {
				...this.plugin.settings,
				provider: visionProvider as AIProvider,
				model: visionModelName,
				// Ensure the correct key is available if it's generic, though ai.ts pulls from specific fields
				// If visionProvider is 'gemini', ai.ts looks at settings.geminiApiKey, which is preserved in spread
			};

			this.items = await generateDeepNotesQuestions(
				userText,
				visionSettings,
				IMAGE_SCAN_SYSTEM_PROMPT,
				undefined,
				allImages
			);

			if (this.items.length === 0) {
				new Notice("No questions generated. Make sure you're using a vision model for image scanning.");
			}
		} catch (e) {
			new Notice(`Image scan error: ${e instanceof Error ? e.message : e}`);
			this.items = [];
		} finally {
			this.loading = false;
			this.render();
		}
	}

	// renderOcrStatus removed — replaced by Scan Images button

	private async triggerEvaluation(): Promise<void> {
		const { provider, model, ollamaBaseUrl } = this.plugin.settings;
		const activeKey = this.getActiveKey();

		if (provider !== "ollama" && !activeKey) {
			new Notice("Please set your API key in Deep Notes settings.");
			return;
		}

		const file = this.app.workspace.getActiveFile();
		if (!file) {
			new Notice("No active note to analyze.");
			return;
		}

		const questionsAndResponses = this.items.map((item, i) => ({
			question: item.text,
			response: this.currentResponses[i] || "",
		}));

		const hasResponse = questionsAndResponses.some((qr) => qr.response.length > 0);
		if (!hasResponse) {
			new Notice("Please respond to at least one question before evaluating.");
			return;
		}

		this.evaluating = true;
		this.render();

		try {
			const noteContent = await this.app.vault.read(file);

			// Index this note for future cross-topic search
			await this.plugin.indexer.indexSingleNote(file);

			this.evaluationResult = await evaluateResponses(
				noteContent,
				this.items,
				this.currentResponses,
				this.plugin.settings,
				model,
				ollamaBaseUrl
			);

			// Save session to history
			const session: QASession = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				notePath: file.path,
				noteTitle: file.basename,
				timestamp: Date.now(),
				items: this.items,
				responses: this.currentResponses,
				evaluation: this.evaluationResult,
			};
			await saveSession(this.plugin, session);

			this.viewMode = "evaluation";

			// Save to cache
			this.saveCurrentStateToCache();

		} catch (e) {
			new Notice(`Evaluation error: ${e instanceof Error ? e.message : e}`);
			this.evaluationResult = null;
		} finally {
			this.evaluating = false;
			this.render();
		}
	}

	private loadSession(session: QASession): void {
		this.items = session.items;
		this.evaluationResult = session.evaluation ?? null;
		this.viewMode = session.evaluation ? "evaluation" : "questions";
		this.currentResponses = session.responses;
		this.textareaRefs = [];
		this.render();
		this.applyQuestionHighlights(); // Restore highlights

		// Restore responses into textareas after render
		if (!session.evaluation) {
			requestAnimationFrame(() => {
				for (let i = 0; i < this.currentResponses.length && i < this.textareaRefs.length; i++) {
					this.textareaRefs[i].value = this.currentResponses[i];
				}
			});
		}

		this.saveCurrentStateToCache();
	}

	private getReviewDate(score: number): Date {
		const now = new Date();
		let daysUntilReview: number;
		if (score >= 90) daysUntilReview = 14;
		else if (score >= 75) daysUntilReview = 7;
		else if (score >= 50) daysUntilReview = 3;
		else daysUntilReview = 1;

		now.setDate(now.getDate() + daysUntilReview);
		return now;
	}

	private getDailyNoteSettings(): { folder: string; format: string } {
		try {
			const internalPlugins = (this.app as any).internalPlugins;
			const dailyNotes = internalPlugins?.getPluginById?.("daily-notes");
			if (dailyNotes?.instance?.options) {
				return {
					folder: dailyNotes.instance.options.folder || "",
					format: dailyNotes.instance.options.format || "YYYY-MM-DD",
				};
			}
		} catch {
			// fall through to defaults
		}
		return { folder: "", format: "YYYY-MM-DD" };
	}

	private formatDateForDailyNote(date: Date, format: string): string {
		const y = date.getFullYear();
		const m = String(date.getMonth() + 1).padStart(2, "0");
		const d = String(date.getDate()).padStart(2, "0");

		return format
			.replace("YYYY", String(y))
			.replace("YY", String(y).slice(2))
			.replace("MM", m)
			.replace("M", String(date.getMonth() + 1))
			.replace("DD", d)
			.replace("D", String(date.getDate()));
	}

	private async scheduleReview(): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file || !this.evaluationResult) return;

		const reviewDate = this.getReviewDate(this.evaluationResult.score);
		const dateStr = reviewDate.toISOString().split("T")[0];
		const noteName = file.basename;

		const { folder, format } = this.getDailyNoteSettings();
		const dailyNoteName = this.formatDateForDailyNote(reviewDate, format);
		const dailyNotePath = folder
			? `${folder}/${dailyNoteName}.md`
			: `${dailyNoteName}.md`;

		const questions = this.evaluationResult.feedback
			.map((f) => `- ${f.question}`)
			.join("\n");

		const reviewBlock = [
			"",
			`## Deep Notes Review: [[${noteName}]]`,
			"",
			`**Score:** ${this.evaluationResult.score}%`,
			`**Summary:** ${this.evaluationResult.summary}`,
			"",
			"### Questions to Re-review",
			questions,
			"",
		].join("\n");

		const existingFile = this.app.vault.getAbstractFileByPath(dailyNotePath);
		if (existingFile) {
			await this.app.vault.append(existingFile as TFile, reviewBlock);
		} else {
			if (folder) {
				await this.ensureFolderExists(folder);
			}
			await this.app.vault.create(dailyNotePath, reviewBlock.trimStart());
		}

		new Notice(`Review scheduled for ${dateStr}! Check your daily note.`);
	}

	private async ensureFolderExists(path: string): Promise<void> {
		const parts = path.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (!existing) {
				await this.app.vault.createFolder(current);
			}
		}
	}

	private render(): void {

		// Always render into a dedicated root div inside contentEl
		let root = this.contentEl.querySelector<HTMLDivElement>(".deep-notes-container-root");
		if (!root) {
			root = this.contentEl.createDiv({ cls: "deep-notes-container-root" });
		}
		root.empty();
		root.addClass("deep-notes-container");
		const container = root;

		const file = this.app.workspace.getActiveFile();
		const noteName = file ? file.basename : "No active note";

		// Header
		const header = container.createDiv({ cls: "deep-notes-header" });
		header.createEl("h4", { text: noteName });

		if (this.loading) {
			container.createDiv({
				cls: "deep-notes-loading",
				text: this.loadingMessage || "Generating questions...",
			});
			return;
		}

		if (this.evaluating) {
			container.createDiv({
				cls: "deep-notes-loading",
				text: "Evaluating your responses...",
			});
			return;
		}

		// History view
		if (this.viewMode === "history") {
			this.renderHistory(container);
			return;
		}

		// Show evaluation results
		if (this.viewMode === "evaluation" && this.evaluationResult) {
			this.renderEvaluationResult(container);
			return;
		}

		if (this.items.length === 0) {
			// Image picker view
			if (this.showImagePicker) {
				this.renderImagePicker(container);
				return;
			}

			const btnStack = container.createDiv({ cls: "deep-notes-btn-stack" });

			const genBtn = btnStack.createEl("button", {
				cls: "deep-notes-generate-btn deep-notes-icon-btn",
			});
			const genIcon = genBtn.createSpan({ cls: "deep-notes-btn-icon" });
			setIcon(genIcon, "lightbulb");
			genBtn.createSpan({ text: "Generate Questions" });
			genBtn.addEventListener("click", () => this.triggerGeneration());

			const scanBtn = btnStack.createEl("button", {
				cls: "deep-notes-generate-btn deep-notes-scan-btn deep-notes-icon-btn",
			});
			const scanIcon = scanBtn.createSpan({ cls: "deep-notes-btn-icon" });
			setIcon(scanIcon, "scan-eye");
			scanBtn.createSpan({ text: "Scan Images" });
			scanBtn.addEventListener("click", () => this.openImagePicker());

			const historyBtn = btnStack.createEl("button", {
				cls: "deep-notes-generate-btn deep-notes-history-btn deep-notes-icon-btn",
			});
			const histIcon = historyBtn.createSpan({ cls: "deep-notes-btn-icon" });
			setIcon(histIcon, "history");
			historyBtn.createSpan({ text: "History" });
			historyBtn.addEventListener("click", () => {
				this.viewMode = "history";
				this.render();
			});

			// Flowchart guide
			this.renderFlowchartGuide(container);

			// Show index status
			this.renderIndexStatus(container);
			return;
		}

		// Clear Cache Button (Top Right)
		const clearBtn = container.createEl("button", {
			text: "Clear Session",
			cls: "deep-notes-generate-btn deep-notes-history-btn",
			attr: { style: "margin-bottom: 8px; font-size: 12px; padding: 4px;" }
		});
		clearBtn.addEventListener("click", () => {
			if (this.lastNotePath) {
				sessionCache.delete(this.lastNotePath);
			}
			this.items = [];
			this.evaluationResult = null;
			this.currentResponses = [];
			this.viewMode = "questions";
			if (this.lastNotePath) {
				clearAllHighlights(this.app, this.lastNotePath);
			} else {
				clearAllHighlights(this.app);
			}
			this.render();
			new Notice("Session cleared.");
		});

		// Evaluate button at top
		const evalBtn = container.createEl("button", {
			text: "Evaluate & Save Session",
			cls: "deep-notes-generate-btn deep-notes-evaluate-btn",
		});
		evalBtn.addEventListener("click", () => this.triggerEvaluation());

		// Render question/suggestion cards
		this.textareaRefs = [];
		for (let idx = 0; idx < this.items.length; idx++) {
			const item = this.items[idx];
			const color = HIGHLIGHT_COLORS[idx % HIGHLIGHT_COLORS.length];
			const card = container.createDiv({ cls: "deep-notes-card" });

			// Color indicator bar
			card.style.borderLeft = `4px solid ${color.border}`;

			const headerRow = card.createDiv({ cls: "deep-notes-card-header" });

			const badgeText =
				item.type === "knowledge-expansion"
					? "Knowledge Expansion"
					: item.type === "cross-topic"
						? "Cross-Topic"
						: "Suggestion";
			headerRow.createEl("span", {
				text: badgeText,
				cls: `deep-notes-badge deep-notes-badge-${item.type}`,
			});

			// Scroll-to-highlight button
			if (item.sourceExcerpt) {
				const locateBtn = headerRow.createEl("button", {
					cls: "deep-notes-locate-btn",
					attr: { "aria-label": "Scroll to highlighted section" },
				});
				locateBtn.style.backgroundColor = color.bg;
				locateBtn.style.borderColor = color.border;
				locateBtn.innerHTML = "📍";
				locateBtn.addEventListener("click", () => {
					scrollToExcerpt(this.app, item.sourceExcerpt!);
				});
			}

			card.createEl("p", { text: item.text, cls: "deep-notes-text" });

			// Show source note link for cross-topic questions
			if (item.type === "cross-topic" && item.sourceNote) {
				const sourceLink = card.createEl("a", {
					text: `📎 From: ${item.sourceNote}`,
					cls: "deep-notes-source-link",
					href: "#",
				});
				sourceLink.addEventListener("click", async (e) => {
					e.preventDefault();
					const files = this.app.vault.getMarkdownFiles();
					const target = files.find(
						(f) => f.basename === item.sourceNote
					);
					if (target) {
						await this.app.workspace.openLinkText(target.path, "");
					} else {
						new Notice(`Note "${item.sourceNote}" not found.`);
					}
				});
			}

			const textarea = card.createEl("textarea", {
				cls: "deep-notes-response",
				placeholder: "Type your response...",
				attr: { rows: "3" },
			}) as HTMLTextAreaElement;
			this.textareaRefs.push(textarea);

			// Init value if exists
			if (this.currentResponses[idx]) {
				textarea.value = this.currentResponses[idx];
			}

			// Save cache on input
			textarea.addEventListener("input", debounce(() => {
				this.currentResponses[idx] = textarea.value.trim();
				this.saveCurrentStateToCache();
			}, 500));

			const addBtn = card.createEl("button", {
				text: "Add to Note",
				cls: "deep-notes-add-btn",
			});
			addBtn.addEventListener("click", async () => {
				const response = textarea.value.trim();
				if (!response) {
					new Notice("Please type a response first.");
					return;
				}

				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice("No active note.");
					return;
				}

				const calloutType =
					item.type === "knowledge-expansion" || item.type === "cross-topic"
						? "question"
						: "note";
				const calloutTitle =
					item.type === "cross-topic"
						? "Cross-Topic Question"
						: item.type === "knowledge-expansion"
							? "Deep Notes Question"
							: "Deep Notes Suggestion";
				const calloutBlock = [
					"",
					`> [!${calloutType}] ${calloutTitle}`,
					`> ${item.text}`,
					`>`,
					`> **Response:** ${response}`,
					"",
				].join("\n");

				await this.app.vault.append(activeFile, calloutBlock);
				new Notice("Added to note!");
				textarea.value = "";
			});
		}

		// Bottom buttons
		const bottomRow = container.createDiv({ cls: "deep-notes-btn-row" });
		bottomRow.style.marginTop = "16px";

		const resetBtn = bottomRow.createEl("button", {
			text: "Regenerate",
			cls: "deep-notes-generate-btn",
		});
		resetBtn.addEventListener("click", () => this.triggerGeneration());

		const histBtn = bottomRow.createEl("button", {
			cls: "deep-notes-generate-btn deep-notes-history-btn deep-notes-icon-btn",
		});
		const histBtnIcon = histBtn.createSpan({ cls: "deep-notes-btn-icon" });
		setIcon(histBtnIcon, "history");
		histBtn.createSpan({ text: "History" });
		histBtn.addEventListener("click", () => {
			this.viewMode = "history";
			this.render();
		});
	}

	private renderHistory(container: HTMLElement): void {
		const file = this.app.workspace.getActiveFile();
		if (!file) {
			container.createDiv({
				cls: "deep-notes-loading",
				text: "No active note.",
			});
			return;
		}

		const sessions = getSessionsForNote(this.plugin, file.path);

		// Back button
		const backBtn = container.createEl("button", {
			cls: "deep-notes-generate-btn deep-notes-regenerate deep-notes-icon-btn",
		});
		const backIcon = backBtn.createSpan({ cls: "deep-notes-btn-icon" });
		setIcon(backIcon, "arrow-left");
		backBtn.createSpan({ text: "Back" });
		backBtn.addEventListener("click", () => {
			this.viewMode = "questions";
			this.render();
		});

		if (sessions.length === 0) {
			container.createDiv({
				cls: "deep-notes-loading",
				text: "No past sessions for this note.",
			});
			return;
		}

		container.createEl("h5", {
			text: `${sessions.length} Past Session${sessions.length > 1 ? "s" : ""}`,
			cls: "deep-notes-history-title",
		});

		for (const session of sessions) {
			const card = container.createDiv({ cls: "deep-notes-card deep-notes-history-card" });

			const dateStr = new Date(session.timestamp).toLocaleDateString("en-US", {
				month: "short",
				day: "numeric",
				year: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			});

			const meta = card.createDiv({ cls: "deep-notes-history-meta" });
			meta.createEl("span", { text: dateStr, cls: "deep-notes-history-date" });

			if (session.evaluation) {
				const scoreClass =
					session.evaluation.score >= 80 ? "score-green" :
						session.evaluation.score >= 50 ? "score-yellow" : "score-red";
				meta.createEl("span", {
					text: `${session.evaluation.score}%`,
					cls: `deep-notes-badge deep-notes-history-score ${scoreClass}`,
				});
			} else {
				meta.createEl("span", {
					text: "Not evaluated",
					cls: "deep-notes-badge",
				});
			}

			card.createEl("p", {
				text: `${session.items.length} questions · ${session.responses.filter((r) => r.length > 0).length} answered`,
				cls: "deep-notes-history-summary",
			});

			const actions = card.createDiv({ cls: "deep-notes-history-actions" });

			const loadBtn = actions.createEl("button", {
				text: "Load",
				cls: "deep-notes-add-btn",
			});
			loadBtn.addEventListener("click", () => this.loadSession(session));

			const delBtn = actions.createEl("button", {
				text: "Delete",
				cls: "deep-notes-add-btn deep-notes-delete-btn",
			});
			delBtn.addEventListener("click", async () => {
				await deleteSession(this.plugin, session.id);
				new Notice("Session deleted.");
				this.render();
			});
		}
	}

	private renderImagePicker(container: HTMLElement): void {
		const picker = container.createDiv({ cls: "deep-notes-image-picker" });

		// Header: title + select all/none inline
		const headerRow = picker.createDiv({ cls: "deep-notes-picker-header" });
		headerRow.createEl("span", { text: "Select images", cls: "deep-notes-picker-title" });

		const controls = headerRow.createDiv({ cls: "deep-notes-picker-controls" });
		const selectAllBtn = controls.createEl("button", {
			text: "All",
			cls: "deep-notes-picker-action",
		});
		selectAllBtn.addEventListener("click", () => {
			for (const img of this.availableImages) {
				this.selectedImagePaths.add(img.path);
			}
			this.render();
		});
		const selectNoneBtn = controls.createEl("button", {
			text: "None",
			cls: "deep-notes-picker-action",
		});
		selectNoneBtn.addEventListener("click", () => {
			this.selectedImagePaths.clear();
			this.render();
		});

		// Image list
		const list = picker.createDiv({ cls: "deep-notes-picker-list" });
		for (const img of this.availableImages) {
			const row = list.createDiv({ cls: "deep-notes-picker-row" });

			const label = row.createEl("label", { cls: "deep-notes-picker-label" });
			const cb = label.createEl("input", {
				type: "checkbox",
				cls: "deep-notes-picker-checkbox",
			}) as HTMLInputElement;
			cb.checked = this.selectedImagePaths.has(img.path);
			cb.addEventListener("change", () => {
				if (cb.checked) {
					this.selectedImagePaths.add(img.path);
				} else {
					this.selectedImagePaths.delete(img.path);
				}
				// Update count display
				const countEl = picker.querySelector(".deep-notes-picker-count");
				if (countEl) {
					countEl.textContent = `${this.selectedImagePaths.size} of ${this.availableImages.length} selected`;
				}
				const scanBtnEl = picker.querySelector(".deep-notes-scan-selected-btn");
				if (scanBtnEl) {
					(scanBtnEl as HTMLButtonElement).disabled = this.selectedImagePaths.size === 0;
				}
			});

			const displayName = img.isExcalidraw
				? img.name.replace(/\.excalidraw$/i, "")
				: `${img.name}.${img.extension}`;
			label.createEl("span", {
				text: displayName,
				cls: "deep-notes-picker-name",
			});

			const badgeText = img.isExcalidraw ? "drawing" : img.extension.toLowerCase();
			label.createEl("span", {
				text: badgeText,
				cls: "deep-notes-picker-badge",
			});
		}

		// Selection count
		picker.createEl("span", {
			text: `${this.selectedImagePaths.size} of ${this.availableImages.length} selected`,
			cls: "deep-notes-picker-count",
		});

		// Action buttons
		const actions = picker.createDiv({ cls: "deep-notes-picker-actions" });
		const scanBtn = actions.createEl("button", {
			text: "Scan",
			cls: "deep-notes-generate-btn deep-notes-scan-selected-btn",
		}) as HTMLButtonElement;
		scanBtn.disabled = this.selectedImagePaths.size === 0;
		scanBtn.addEventListener("click", () => this.triggerImageScan());

		const cancelBtn = actions.createEl("button", {
			text: "Cancel",
			cls: "deep-notes-generate-btn",
		});
		cancelBtn.addEventListener("click", () => {
			this.showImagePicker = false;
			this.render();
		});
	}

	private renderFlowchartGuide(container: HTMLElement): void {
		const guide = container.createDiv({ cls: "deep-notes-flowchart" });
		guide.createEl("p", { text: "How it works", cls: "deep-notes-flowchart-title" });

		const steps = [
			{ icon: "file-text", label: "Open a note", desc: "Navigate to any markdown note" },
			{ icon: "lightbulb", label: "Generate questions", desc: "AI reads your note and creates questions" },
			{ icon: "pencil", label: "Answer them", desc: "Type your responses to test your understanding" },
			{ icon: "bar-chart-2", label: "Evaluate", desc: "Get a score and feedback on your answers" },
			{ icon: "calendar", label: "Review later", desc: "Sessions are saved and review is scheduled" },
		];

		for (let i = 0; i < steps.length; i++) {
			const step = steps[i];

			const node = guide.createDiv({ cls: "deep-notes-flow-node" });
			const iconEl = node.createDiv({ cls: "deep-notes-flow-icon" });
			setIcon(iconEl, step.icon);
			const textEl = node.createDiv({ cls: "deep-notes-flow-text" });
			textEl.createEl("span", { text: step.label, cls: "deep-notes-flow-label" });
			textEl.createEl("span", { text: step.desc, cls: "deep-notes-flow-desc" });

			// Connector line between nodes
			if (i < steps.length - 1) {
				guide.createDiv({ cls: "deep-notes-flow-connector" });
			}
		}
	}

	private async renderIndexStatus(container: HTMLElement): Promise<void> {
		const statusDiv = container.createDiv({ cls: "deep-notes-index-status" });

		try {
			const stats = await this.plugin.vectorStore.getStats();
			if (stats.totalChunks === 0) {
				statusDiv.createEl("p", {
					text: "Vault not indexed. Index your vault to enable cross-topic questions.",
					cls: "deep-notes-index-notice",
				});
				const indexBtn = statusDiv.createEl("button", {
					text: "Index Vault Now",
					cls: "deep-notes-generate-btn deep-notes-index-btn",
				});
				indexBtn.addEventListener("click", () => {
					this.plugin.indexer.indexVault();
				});
			} else {
				statusDiv.createEl("p", {
					text: `✓ ${stats.totalChunks} chunks indexed for cross-topic search.`,
					cls: "deep-notes-index-ready",
				});
			}
		} catch {
			statusDiv.createEl("p", {
				text: "Could not read index status.",
				cls: "deep-notes-index-notice",
			});
		}
	}

	private renderEvaluationResult(container: HTMLElement): void {
		const result = this.evaluationResult!;

		// Big overall score display
		const scoreSection = container.createDiv({ cls: "deep-notes-score-section" });
		const scoreColorClass =
			result.score >= 80 ? "score-green" :
				result.score >= 50 ? "score-yellow" : "score-red";

		const scoreEl = scoreSection.createDiv({
			cls: `deep-notes-score ${scoreColorClass}`,
		});
		scoreEl.createEl("span", {
			text: `${result.score}%`,
			cls: "deep-notes-score-value",
		});
		scoreEl.createEl("span", {
			text: "Understanding",
			cls: "deep-notes-score-label",
		});

		// Summary
		if (result.summary) {
			container.createDiv({
				cls: "deep-notes-summary",
				text: result.summary,
			});
		}

		// Per-question feedback — compact with inline mini score
		for (const fb of result.feedback) {
			const card = container.createDiv({ cls: "deep-notes-feedback-card" });

			// Header row: rating badge (small) + individual score
			const fbHeader = card.createDiv({ cls: "deep-notes-feedback-header" });
			const ratingClass = `rating-${fb.rating}`;
			fbHeader.createEl("span", {
				text: fb.rating.charAt(0).toUpperCase() + fb.rating.slice(1),
				cls: `deep-notes-badge deep-notes-rating-badge ${ratingClass}`,
			});
			// Show individual score as small text
			const individualScore = fb.rating === "correct" ? 100 : fb.rating === "partial" ? 50 : 0;
			fbHeader.createEl("span", {
				text: `${individualScore}%`,
				cls: `deep-notes-individual-score ${ratingClass}`,
			});

			card.createEl("p", {
				text: fb.question,
				cls: "deep-notes-text deep-notes-feedback-question",
			});

			card.createEl("p", {
				text: fb.explanation,
				cls: "deep-notes-feedback-explanation",
			});

			// Suggested answer (collapsible)
			if (fb.suggestedAnswer) {
				const details = card.createEl("details", {
					cls: "deep-notes-suggested-answer",
				});
				const summary = details.createEl("summary");
				const summaryIcon = summary.createSpan({ cls: "deep-notes-btn-icon" });
				setIcon(summaryIcon, "message-circle");
				summary.createSpan({ text: " Suggested Answer" });
				details.createEl("p", {
					text: fb.suggestedAnswer,
					cls: "deep-notes-suggested-answer-text",
				});
			}
		}

		// Action buttons
		const btnRow = container.createDiv({ cls: "deep-notes-btn-row" });

		// Schedule Review button
		const scheduleBtn = btnRow.createEl("button", {
			text: "Schedule Review",
			cls: "deep-notes-generate-btn deep-notes-schedule-btn",
		});
		const reviewDate = this.getReviewDate(result.score);
		const dateStr = reviewDate.toISOString().split("T")[0];
		scheduleBtn.createEl("small", {
			text: ` (${dateStr})`,
		});
		scheduleBtn.addEventListener("click", () => this.scheduleReview());

		// Back button
		const backBtn = btnRow.createEl("button", {
			text: "Back to Questions",
			cls: "deep-notes-generate-btn deep-notes-regenerate",
		});
		backBtn.addEventListener("click", () => {
			this.evaluationResult = null;
			this.viewMode = "questions";
			this.render();
		});
	}
}
