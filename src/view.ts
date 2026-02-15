import { ItemView, Notice, WorkspaceLeaf, TFile, debounce } from "obsidian";
import { VIEW_TYPE_DEEP_NOTES } from "./constants";
import { generateDeepNotesQuestions, evaluateResponses, DeepNotesItem, EvaluationResult } from "./ai";
import { getEmbedding } from "./embeddings";
import type DeepNotesPlugin from "./main";

export class DeepNotesView extends ItemView {
	plugin: DeepNotesPlugin;
	private items: DeepNotesItem[] = [];
	private loading = false;
	private evaluating = false;
	private evaluationResult: EvaluationResult | null = null;
	private textareaRefs: HTMLTextAreaElement[] = [];

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
				debounce(() => {
					this.items = [];
					this.evaluationResult = null;
					this.textareaRefs = [];
					this.render();
				}, 300)
			)
		);
		this.render();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
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
		this.evaluationResult = null;
		this.textareaRefs = [];
		this.render();

		try {
			const content = await this.app.vault.read(file);

			// Search for related notes via vector store
			let relatedContext = undefined;
			try {
				const stats = await this.plugin.vectorStore.getStats();
				if (stats.totalChunks > 0) {
					const queryEmbedding = await getEmbedding(content, this.plugin.settings);
					const results = await this.plugin.vectorStore.search(
						queryEmbedding,
						5,
						file.path
					);
					if (results.length > 0) {
						relatedContext = results;
					}
				}
			} catch (e) {
				console.warn("Cross-topic search failed, generating without context:", e);
			}

			this.items = await generateDeepNotesQuestions(
				content,
				provider,
				activeKey,
				model,
				systemPrompt,
				ollamaBaseUrl,
				relatedContext
			);
		} catch (e) {
			new Notice(`Deep Notes error: ${e instanceof Error ? e.message : e}`);
			this.items = [];
		} finally {
			this.loading = false;
			this.render();
		}
	}

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
			response: this.textareaRefs[i]?.value.trim() ?? "",
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
				questionsAndResponses,
				provider,
				activeKey,
				model,
				ollamaBaseUrl
			);
		} catch (e) {
			new Notice(`Evaluation error: ${e instanceof Error ? e.message : e}`);
			this.evaluationResult = null;
		} finally {
			this.evaluating = false;
			this.render();
		}
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
		const container = this.contentEl;
		container.empty();
		container.addClass("deep-notes-container");

		const file = this.app.workspace.getActiveFile();
		const noteName = file ? file.basename : "No active note";

		// Header
		const header = container.createDiv({ cls: "deep-notes-header" });
		header.createEl("h4", { text: noteName });

		if (this.loading) {
			container.createDiv({
				cls: "deep-notes-loading",
				text: "Generating questions...",
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

		if (this.items.length === 0) {
			const btn = container.createEl("button", {
				text: "Generate Deep Notes Questions",
				cls: "deep-notes-generate-btn",
			});
			btn.addEventListener("click", () => this.triggerGeneration());

			// Show index status
			this.renderIndexStatus(container);
			return;
		}

		// Show evaluation results
		if (this.evaluationResult) {
			this.renderEvaluationResult(container);
			return;
		}

		// Evaluate button at top
		const evalBtn = container.createEl("button", {
			text: "Evaluate",
			cls: "deep-notes-generate-btn deep-notes-evaluate-btn",
		});
		evalBtn.addEventListener("click", () => this.triggerEvaluation());

		// Render question/suggestion cards
		this.textareaRefs = [];
		for (const item of this.items) {
			const card = container.createDiv({ cls: "deep-notes-card" });

			const badgeText =
				item.type === "knowledge-expansion"
					? "Knowledge Expansion"
					: item.type === "cross-topic"
						? "Cross-Topic"
						: "Suggestion";
			card.createEl("span", {
				text: badgeText,
				cls: `deep-notes-badge deep-notes-badge-${item.type}`,
			});

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

		// Regenerate button at bottom
		const resetBtn = container.createEl("button", {
			text: "Regenerate",
			cls: "deep-notes-generate-btn deep-notes-regenerate",
		});
		resetBtn.addEventListener("click", () => this.triggerGeneration());
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

		// Score display
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

		// Per-question feedback
		for (const fb of result.feedback) {
			const card = container.createDiv({ cls: "deep-notes-feedback-card" });

			const ratingClass = `rating-${fb.rating}`;
			card.createEl("span", {
				text: fb.rating.charAt(0).toUpperCase() + fb.rating.slice(1),
				cls: `deep-notes-badge deep-notes-rating-badge ${ratingClass}`,
			});

			card.createEl("p", {
				text: fb.question,
				cls: "deep-notes-text deep-notes-feedback-question",
			});

			card.createEl("p", {
				text: fb.explanation,
				cls: "deep-notes-feedback-explanation",
			});
		}

		// Schedule Review button
		const scheduleBtn = container.createEl("button", {
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
		const backBtn = container.createEl("button", {
			text: "Back to Questions",
			cls: "deep-notes-generate-btn deep-notes-regenerate",
		});
		backBtn.addEventListener("click", () => {
			this.evaluationResult = null;
			this.render();
		});
	}
}
