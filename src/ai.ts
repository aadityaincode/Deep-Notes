import { requestUrl } from "obsidian";
import type { SearchResult } from "./vectorStore";
import type { ImagePayload } from "./ocr";
import type { DeepNotesSettings, DeepNotesStudyMode } from "./settings";
import { getEmbedding } from "./embeddings";

// API response types
interface OllamaChatResponse {
	message?: { content?: string };
}

interface OllamaTagsResponse {
	models?: { name?: string }[];
}

interface GeminiResponse {
	candidates?: { content?: { parts?: { text?: string }[] } }[];
}

export interface DeepNotesItem {
	type: "knowledge-expansion" | "suggestion" | "cross-topic";
	text: string;
	sourceExcerpt?: string;
	sourceNote?: string;
	sampleAnswer?: string;
	sampleAnswerEmbedding?: number[];
	subItems?: DeepNotesItem[];
	userResponse?: string;
	options?: string[];
	correctOption?: string;
}

export interface EvaluationFeedback {
	question: string;
	rating: "correct" | "partial" | "incorrect";
	explanation: string;
	suggestedAnswer?: string;
}

export interface EvaluationResult {
	score: number;
	feedback: EvaluationFeedback[];
	summary: string;
}

interface GeminiCacheEntry {
	filePath: string;
	cacheName: string;
	expiresAt: number;
}

export class GeminiCacheManager {
	private activeCache: GeminiCacheEntry | null = null;

	async getOrCreateCache(
		filePath: string,
		noteContent: string,
		systemPrompt: string,
		model: string,
		apiKey: string
	): Promise<string | null> {
		const now = Date.now();
		if (
			this.activeCache &&
			this.activeCache.filePath === filePath &&
			this.activeCache.expiresAt > now
		) {
			return this.activeCache.cacheName;
		}

		const ttlSeconds = 900;
		const url = `https://generativelanguage.googleapis.com/v1beta/cachedContents?key=${apiKey}`;

		try {
			const response = await requestUrl({
				url,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: `models/${model}`,
					ttl: `${ttlSeconds}s`,
					systemInstruction: { parts: [{ text: systemPrompt }] },
					contents: [{ role: "user", parts: [{ text: noteContent }] }],
				}),
			});

			if (response.status !== 200) {
				console.debug(`[DeepNotes] Cache creation skipped (${response.status}): content may be below minimum token threshold`);
				return null;
			}

			const data = response.json as { name?: string };
			if (!data.name) return null;

			this.activeCache = { filePath, cacheName: data.name, expiresAt: now + ttlSeconds * 1000 };
			console.debug(`[DeepNotes] Gemini context cache created: ${data.name}`);
			return data.name;
		} catch {
			return null;
		}
	}

	invalidate(): void {
		this.activeCache = null;
	}
}

export const STUDY_MODE_SYSTEM_PROMPTS: Record<DeepNotesStudyMode, string> = {
	"socratic": "", // Caller provides the user's custom system prompt
	"active-recall": `You are a quiz generator. Create exactly 6 multiple-choice questions that test specific facts, definitions, and concepts from the provided note. Each question must have exactly 4 answer choices as complete sentences. Output a JSON array of items.`,
	"feynman": `You are a Feynman technique tutor. Identify the single most complex or abstract concept from the provided note. Generate exactly 1 challenge asking the user to explain it in plain language a 10-year-old could understand, without using jargon. Output a JSON array with 1 item.`,
	"flashcard": `You are an Anki flashcard creator. Generate exactly 8 flashcard pairs that cover the most important concepts, definitions, and relationships from the provided note. The "text" field is the front (question/prompt), and "sample_answer" is the back (answer). Output a JSON array of items.`,
};

const SOCRATIC_SCHEMA = {
	type: "ARRAY",
	items: {
		type: "OBJECT",
		properties: {
			type: { type: "STRING", enum: ["knowledge-expansion", "suggestion", "cross-topic"] },
			text: { type: "STRING" },
			sample_answer: { type: "STRING" },
			source_excerpt: { type: "STRING" },
			sourceNote: { type: "STRING" },
		},
		required: ["type", "text", "sample_answer", "source_excerpt"],
	},
};

const ACTIVE_RECALL_SCHEMA = {
	type: "ARRAY",
	items: {
		type: "OBJECT",
		properties: {
			type: { type: "STRING", enum: ["knowledge-expansion"] },
			text: { type: "STRING" },
			options: { type: "ARRAY", items: { type: "STRING" } },
			correct_option: { type: "STRING" },
			sample_answer: { type: "STRING" },
			source_excerpt: { type: "STRING" },
		},
		required: ["type", "text", "options", "correct_option", "sample_answer"],
	},
};

const FLASHCARD_SCHEMA = {
	type: "ARRAY",
	items: {
		type: "OBJECT",
		properties: {
			type: { type: "STRING", enum: ["suggestion"] },
			text: { type: "STRING" },
			sample_answer: { type: "STRING" },
			source_excerpt: { type: "STRING" },
		},
		required: ["type", "text", "sample_answer"],
	},
};

// Generates Deep Notes questions using the selected AI provider
export async function generateDeepNotesQuestions(
	noteContent: string,
	settings: DeepNotesSettings,
	systemPrompt: string,
	relatedContext?: SearchResult[],
	images?: ImagePayload[],
	studyMode?: DeepNotesStudyMode,
	filePath?: string,
	cacheManager?: GeminiCacheManager
): Promise<DeepNotesItem[]> {
	let userMessage = noteContent;

	// Add related context to the user message if available
	if (relatedContext && relatedContext.length > 0) {
		const contextBlock = relatedContext
			.map((r) => `- From "${r.noteTitle}" (${r.heading}): ${r.text}`)
			.join("\n");
		userMessage = `## Current Note\n${noteContent}\n\n## Related Concepts from Other Notes\n${contextBlock}`;
	}

	const imgs = images && images.length > 0 ? images : undefined;
	let content: string;
	const provider = settings.provider;
	let apiKey = "";
	if (provider === "gemini") {
		apiKey = settings.geminiApiKey;
	}

	const mode = studyMode ?? "socratic";
	const effectiveSystemPrompt = mode === "socratic"
		? systemPrompt
		: STUDY_MODE_SYSTEM_PROMPTS[mode];

	const geminiSchema = mode === "active-recall"
		? ACTIVE_RECALL_SCHEMA
		: mode === "flashcard"
			? FLASHCARD_SCHEMA
			: SOCRATIC_SCHEMA;

	// Phase 5A: try Gemini context caching for large note contexts
	let geminiCacheName: string | null = null;
	if (provider === "gemini" && cacheManager && filePath && apiKey) {
		geminiCacheName = await cacheManager.getOrCreateCache(
			filePath,
			noteContent,
			effectiveSystemPrompt,
			settings.model,
			apiKey
		);
	}

	// Call the appropriate AI provider
	switch (provider) {
		case "gemini":
			if (geminiCacheName) {
				const generationRequest = relatedContext && relatedContext.length > 0
					? `Using the note above and these related concepts:\n${relatedContext.map((r) => `- From "${r.noteTitle}": ${r.text}`).join("\n")}\n\nGenerate questions as specified in the system instruction.`
					: "Generate questions for this note as specified in the system instruction.";
				content = await callGeminiCached(generationRequest, apiKey, settings.model, geminiCacheName, geminiSchema);
			} else {
				content = await callGemini(userMessage, apiKey, settings.model, effectiveSystemPrompt, imgs, geminiSchema);
			}
			break;
		case "ollama":
			content = await callOllama(userMessage, settings.model, effectiveSystemPrompt, settings.ollamaBaseUrl, imgs);
			break;
	}

	const items = parseResponse(content);

	// Generate embeddings for sample answers
	for (const item of items) {
		if (item.sampleAnswer) {
			try {
				const embedding = await getEmbedding(item.sampleAnswer, settings);
				if (embedding) {
					item.sampleAnswerEmbedding = embedding;
				}
			} catch (e) {
				console.warn("Deep Notes: Failed to generate embedding for sample answer", e);
			}
		}
	}

	return items;
}

// Calls Ollama's local LLM API to generate content
async function callOllama(
	noteContent: string,
	model: string,
	systemPrompt: string,
	baseUrl = "http://127.0.0.1:11434",
	images?: ImagePayload[]
): Promise<string> {
	const normalizedBase = baseUrl.replace(/\/$/, "");
	const doChat = async (targetModel: string) => {
		const userMsg: Record<string, unknown> = { role: "user", content: noteContent };
		if (images && images.length > 0) {
			userMsg.images = images.map((img) => img.base64);
		}
		return requestUrl({
			url: `${normalizedBase}/api/chat`,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: targetModel,
				stream: false,
				messages: [
					{ role: "system", content: systemPrompt },
					userMsg,
				],
			}),
		});
	};

	let response = await doChat(model);
	if (response.status !== 200) {
		const err = response.text;
		if (response.status === 404 && /not found/i.test(err)) {
			const fallbackModel = await findOllamaFallbackModel(model, normalizedBase);
			if (fallbackModel) {
				response = await doChat(fallbackModel);
				if (response.status === 200) {
					return (response.json as OllamaChatResponse).message?.content ?? "";
				}
			}

			throw new Error(
				`Ollama model "${model}" was not found locally. Try model "${model.split(":")[0]}:latest" or run: ollama pull ${model}`
			);
		}

		throw new Error(`Ollama API error (${response.status}): ${err}`);
	}

	return (response.json as OllamaChatResponse).message?.content ?? "";
}

async function findOllamaFallbackModel(model: string, normalizedBase: string): Promise<string | null> {
	try {
		const tagsResponse = await requestUrl({
			url: `${normalizedBase}/api/tags`,
			method: "GET",
		});
		if (tagsResponse.status !== 200) {
			return null;
		}

		const tagsData = tagsResponse.json as OllamaTagsResponse;
		const modelNames: string[] = Array.isArray(tagsData.models)
			? tagsData.models.map((m) => m.name ?? "").filter(Boolean)
			: [];

		if (modelNames.length === 0) {
			return null;
		}

		const base = model.split(":")[0];
		const latest = `${base}:latest`;
		if (modelNames.includes(latest)) {
			return latest;
		}

		const firstMatchingTag = modelNames.find((name) => name.startsWith(`${base}:`));
		return firstMatchingTag ?? null;
	} catch {
		return null;
	}
}

function parseResponse(content: string): DeepNotesItem[] {
	const normalized = stripCodeFences(content).trim();
	const candidates = extractJsonCandidates(content, normalized);

	for (const candidate of candidates) {
		try {
			const cleaned = cleanJsonCandidate(candidate);
			const parsed: unknown = JSON.parse(cleaned);
			const items = parseDeepNotesItems(parsed);
			if (items.length > 0) {
				return items;
			}
		} catch (e) {
			console.warn("Deep Notes: JSON parse failed", e);
		}
	}

	const textFieldItems = extractTextFieldsFromJsonLikeText(normalized);
	if (textFieldItems.length > 0) {
		return textFieldItems;
	}

	const listItems = parseListItemsFromText(normalized);
	if (listItems.length > 0) {
		return listItems.map((text) => ({ type: "knowledge-expansion", text }));
	}

	if (!normalized) {
		return [];
	}

	return [{ type: "suggestion", text: toHumanReadableText(normalized) }];
}

function stripCodeFences(content: string): string {
	return content.replace(/```(?:json)?/gi, "").replace(/```/g, "");
}

function cleanJsonCandidate(candidate: string): string {
	return candidate
		.replace(/,\s*([\]}])/g, "$1")
		// eslint-disable-next-line no-control-regex -- We intentionally need to strip these characters from the AI output to ensure valid JSON parsing.
		.replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

function extractJsonCandidates(raw: string, normalized: string): string[] {
	const candidates: string[] = [];

	const blockRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
	let blockMatch: RegExpExecArray | null = null;
	while ((blockMatch = blockRegex.exec(raw)) !== null) {
		const block = blockMatch[1]?.trim();
		if (block && (block.startsWith("[") || block.startsWith("{"))) {
			candidates.push(block);
		}
	}

	if (normalized.startsWith("[") || normalized.startsWith("{")) {
		candidates.push(normalized);
	}

	const arrayMatch = normalized.match(/\[[\s\S]*\]/);
	if (arrayMatch) {
		candidates.push(arrayMatch[0]);
	}

	const objectMatch = normalized.match(/\{[\s\S]*\}/);
	if (objectMatch) {
		candidates.push(objectMatch[0]);
	}

	return Array.from(new Set(candidates.map((c) => c.trim()).filter(Boolean)));
}

function parseDeepNotesItems(parsed: unknown): DeepNotesItem[] {
	if (Array.isArray(parsed)) {
		return parsed
			.map((entry) => normalizeDeepNotesItem(entry))
			.filter((item): item is DeepNotesItem => item !== null);
	}

	if (parsed && typeof parsed === "object") {
		const obj = parsed as Record<string, unknown>;
		for (const key of ["items", "questions", "suggestions", "results", "data"]) {
			if (Array.isArray(obj[key])) {
				return (obj[key] as unknown[])
					.map((entry) => normalizeDeepNotesItem(entry))
					.filter((item): item is DeepNotesItem => item !== null);
			}
		}

		const single = normalizeDeepNotesItem(obj);
		if (single) {
			return [single];
		}
	}

	return [];
}

function normalizeDeepNotesItem(entry: unknown): DeepNotesItem | null {
	if (typeof entry === "string") {
		const text = toHumanReadableText(entry);
		return text ? { type: "knowledge-expansion", text } : null;
	}

	if (!entry || typeof entry !== "object") {
		return null;
	}

	const item = entry as Record<string, unknown>;
	const rawText = item.text ?? item.question ?? item.prompt ?? item.suggestion ?? item.content;
	if (typeof rawText !== "string") {
		return null;
	}

	const text = toHumanReadableText(rawText);
	if (!text) {
		return null;
	}

	const sampleAnswer =
		typeof item.sample_answer === "string"
			? toHumanReadableText(item.sample_answer)
			: typeof item.answer === "string"
				? toHumanReadableText(item.answer)
				: undefined;

	const rawTypeValue = item.type ?? item.kind ?? item.category ?? "";
	const rawType = (typeof rawTypeValue === "string" ? rawTypeValue : "").toLowerCase();
	const type: DeepNotesItem["type"] =
		rawType === "knowledge-expansion" || rawType === "question"
			? "knowledge-expansion"
			: rawType === "cross-topic"
				? "cross-topic"
				: "suggestion";

	const sourceExcerpt =
		typeof item.sourceExcerpt === "string"
			? item.sourceExcerpt
			: typeof item.source_excerpt === "string"
				? item.source_excerpt
				: typeof item.excerpt === "string"
					? item.excerpt
					: typeof item.quote === "string"
						? item.quote
						: undefined;

	const sourceNote =
		typeof item.sourceNote === "string"
			? item.sourceNote
			: typeof item.note === "string"
				? item.note
				: typeof item.relatedNote === "string"
					? item.relatedNote
					: undefined;

	const options = Array.isArray(item.options)
		? (item.options as string[]).filter((o) => typeof o === "string")
		: undefined;

	const correctOption =
		typeof item.correct_option === "string"
			? item.correct_option
			: typeof item.correctOption === "string"
				? item.correctOption
				: undefined;

	return { type, text, sourceExcerpt, sourceNote, sampleAnswer, options, correctOption };
}

function extractTextFieldsFromJsonLikeText(content: string): DeepNotesItem[] {
	const matches = Array.from(content.matchAll(/"text"\s*:\s*"([\s\S]*?)"/g));
	if (matches.length === 0) {
		return [];
	}

	const items = matches
		.map((m) => decodeJsonString(m[1]))
		.map((text) => toHumanReadableText(text))
		.filter((text) => text.length > 0)
		.map((text) => ({ type: "knowledge-expansion", text } as DeepNotesItem));

	return items;
}

function decodeJsonString(value: string): string {
	try {
		return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
	} catch {
		return value;
	}
}

function parseListItemsFromText(content: string): string[] {
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	const parsed = lines
		.map((line) => {
			const bullet = line.match(/^(?:[-*•]|\d+[.)])\s+(.+)$/);
			if (bullet) {
				return bullet[1];
			}

			const label = line.match(/^(?:q(?:uestion)?\s*\d*[.:~-]|suggestion\s*\d*[.:~-])\s*(.+)$/i);
			return label ? label[1] : "";
		})
		.map((line) => toHumanReadableText(line))
		.filter((line) => line.length > 0);

	return parsed.length >= 2 ? parsed : [];
}

function toHumanReadableText(value: string): string {
	return value
		.replace(/\\n/g, " ")
		.replace(/\\t/g, " ")
		.replace(/\\r/g, " ")
		.replace(/\\"/g, '"')
		.replace(/^[\s"'`]+|[\s"'`]+$/g, "")
		.replace(/^(?:[-*•]|\d+[.)])\s+/, "")
		.replace(/\*\*/g, "")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

async function callGemini(
	noteContent: string,
	apiKey: string,
	model: string,
	systemPrompt: string,
	images?: ImagePayload[],
	schema?: object
): Promise<string> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

	// Build parts: images first, then text
	const parts: unknown[] = [];
	if (images && images.length > 0) {
		for (const img of images) {
			parts.push({
				inlineData: {
					mimeType: img.mimeType,
					data: img.base64,
				},
			});
		}
	}
	parts.push({ text: noteContent });

	const response = await requestUrl({
		url,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			system_instruction: {
				parts: [{ text: systemPrompt }],
			},
			contents: [
				{
					role: "user",
					parts,
				},
			],
			generationConfig: {
				temperature: 0.4,
				...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
			},
		}),
	});

	if (response.status !== 200) {
		throw new Error(`Gemini API error (${response.status}): ${response.text}`);
	}

	return (response.json as GeminiResponse).candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function callGeminiCached(
	generationPrompt: string,
	apiKey: string,
	model: string,
	cacheName: string,
	schema?: object
): Promise<string> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

	const response = await requestUrl({
		url,
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			cachedContent: cacheName,
			contents: [{ role: "user", parts: [{ text: generationPrompt }] }],
			generationConfig: {
				temperature: 0.4,
				...(schema ? { responseMimeType: "application/json", responseSchema: schema } : {}),
			},
		}),
	});

	if (response.status !== 200) {
		throw new Error(`Gemini cached API error (${response.status}): ${response.text}`);
	}

	return (response.json as GeminiResponse).candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function evaluateWithLLM(
	question: string,
	sampleAnswer: string | undefined,
	userResponse: string,
	settings: DeepNotesSettings
): Promise<{ rating: "correct" | "partial" | "incorrect"; score: number; explanation: string }> {
	if (!sampleAnswer || !userResponse.trim()) {
		return { rating: "incorrect", score: 0, explanation: "No response provided." };
	}

	const prompt = `You are grading a student's answer. Be concise.

Question: ${question}
Ideal Answer: ${sampleAnswer}
Student's Answer: ${userResponse}

Rate as "correct" (covers key points), "partial" (partially correct), or "incorrect" (wrong/off-topic).
Output JSON only: {"rating": "correct|partial|incorrect", "score": 0-100, "explanation": "1-2 sentences"}`;

	try {
		if (settings.provider === "gemini") {
			const raw = await callGemini(prompt, settings.geminiApiKey, settings.model, "You are a concise grader.", undefined, {
				type: "OBJECT",
				properties: {
					rating: { type: "STRING", enum: ["correct", "partial", "incorrect"] },
					score: { type: "NUMBER" },
					explanation: { type: "STRING" },
				},
				required: ["rating", "score", "explanation"],
			});
			const parsed = JSON.parse(raw) as { rating: "correct" | "partial" | "incorrect"; score: number; explanation: string };
			return parsed;
		} else if (settings.provider === "ollama") {
			const raw = await callOllama(prompt, settings.model, "You are a concise grader. Output only JSON.", settings.ollamaBaseUrl);
			try {
				return JSON.parse(raw.replace(/```json|```/gi, "").trim()) as { rating: "correct" | "partial" | "incorrect"; score: number; explanation: string };
			} catch {
				return { rating: "partial", score: 50, explanation: "Evaluation unavailable." };
			}
		}
	} catch {
		// Graceful fallback
	}
	return { rating: "partial", score: 50, explanation: "Evaluation unavailable." };
}

export async function evaluateResponses(
	noteContent: string,
	items: DeepNotesItem[],
	userResponses: string[],
	settings: DeepNotesSettings
): Promise<EvaluationResult> {
	const provider = settings.provider;
	const hasApiKey = provider === "ollama" || !!settings.geminiApiKey;

	// Collect all (item, response) pairs that have a response
	const evaluationTasks = items.map((item, i) => ({
		item,
		response: userResponses[i] || "",
		index: i,
	}));

	let feedback: EvaluationFeedback[];

	if (hasApiKey && evaluationTasks.some((t) => t.response.trim().length > 3)) {
		// Phase 4C: LLM-as-Judge evaluation (all questions in parallel)
		const results = await Promise.all(
			evaluationTasks.map(async ({ item, response }) => {
				// MCQ: score by exact match against correctOption
				if (item.options && item.correctOption) {
					const isCorrect = response.trim() === item.correctOption.trim();
					return {
						question: item.text,
						rating: isCorrect ? "correct" as const : "incorrect" as const,
						explanation: isCorrect ? "Correct!" : `The correct answer was: ${item.correctOption}`,
						suggestedAnswer: item.correctOption,
					};
				}

				if (response.trim().length <= 3) {
					return {
						question: item.text,
						rating: "incorrect" as const,
						explanation: "No response provided.",
						suggestedAnswer: item.sampleAnswer,
					};
				}
				const judgment = await evaluateWithLLM(item.text, item.sampleAnswer, response, settings);
				return {
					question: item.text,
					rating: judgment.rating,
					explanation: judgment.explanation,
					suggestedAnswer: item.sampleAnswer,
				};
			})
		);
		feedback = results;
	} else {
		// Fallback: cosine similarity grading
		feedback = await Promise.all(
			evaluationTasks.map(async ({ item, response }) => {
				// MCQ: score by exact match against correctOption
				if (item.options && item.correctOption) {
					const isCorrect = response.trim() === item.correctOption.trim();
					return {
						question: item.text,
						rating: isCorrect ? "correct" as const : "incorrect" as const,
						explanation: isCorrect ? "Correct!" : `The correct answer was: ${item.correctOption}`,
						suggestedAnswer: item.correctOption,
					};
				}

				if (response.trim().length <= 3) {
					return {
						question: item.text,
						rating: "incorrect" as const,
						explanation: "No response provided.",
						suggestedAnswer: item.sampleAnswer,
					};
				}

				let similarityScore = 0;
				if (item.sampleAnswerEmbedding) {
					try {
						const userEmbedding = await getEmbedding(response, settings);
						if (userEmbedding && userEmbedding.length > 0) {
							similarityScore = cosineSimilarity(item.sampleAnswerEmbedding, userEmbedding);
						}
					} catch (e) {
						console.warn("Deep Notes: Failed to generate embedding for user response", e);
					}
				}

				const pct = Math.round(similarityScore * 100);
				const rating: "correct" | "partial" | "incorrect" =
					similarityScore >= 0.85 ? "correct" :
					similarityScore >= 0.70 ? "partial" : "incorrect";

				return {
					question: item.text,
					rating,
					explanation: `Similarity: ${pct}%`,
					suggestedAnswer: item.sampleAnswer,
				};
			})
		);
	}

	const answeredCount = evaluationTasks.filter((t) => t.response.trim().length > 3).length;
	const scoreMap: Record<string, number> = { correct: 100, partial: 55, incorrect: 10 };
	const totalScore = feedback.reduce((sum, fb) => {
		if (evaluationTasks[feedback.indexOf(fb)]?.response.trim().length > 3) {
			return sum + (scoreMap[fb.rating] ?? 0);
		}
		return sum;
	}, 0);

	const finalScore = answeredCount > 0 ? Math.round(totalScore / items.length) : 0;

	let summary = "";
	if (finalScore >= 90) summary = "Outstanding! You have a deep understanding of this material.";
	else if (finalScore >= 70) summary = "Great job! You grasped most concepts well.";
	else if (finalScore >= 50) summary = "Good start. Review the partial matches to deepen your understanding.";
	else summary = "Keep practicing. Focus on the core concepts and try again.";

	return { score: finalScore, feedback, summary };
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
	if (vecA.length !== vecB.length) return 0;
	let dot = 0;
	let magA = 0;
	let magB = 0;
	for (let i = 0; i < vecA.length; i++) {
		dot += vecA[i] * vecB[i];
		magA += vecA[i] * vecA[i];
		magB += vecB[i] * vecB[i];
	}
	return magA === 0 || magB === 0 ? 0 : dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export async function generateDeepNotesSubQuestions(
	originalQuestion: string,
	originalSampleAnswer: string | undefined,
	userResponse: string,
	noteContent: string,
	settings: DeepNotesSettings,
	systemPrompt: string // We can reuse the main prompt or a specific one
): Promise<DeepNotesItem[]> {
	const prompt = `
You are a Socratic tutor. The user has answered a question about their note.
Your goal is to generate 1 follow-up question to probe deeper into their understanding, challenge a misconception, or ask for clarification.

Original Question: "${originalQuestion}"
Ideal Answer: "${originalSampleAnswer || "N/A"}"
User's Response: "${userResponse}"

Current Note Context:
${noteContent.slice(0, 3000)}

Output exactly 1 item as a JSON array of objects.
The object MUST have:
- "type": "knowledge-expansion"
- "text": The content of the follow-up question.
- "sample_answer": A concise, ideal answer to this follow-up question.
- "source_excerpt": (Optional) If there is a specific quote in the text relevant to this new question, include it.

Example:
[
  {
    "type": "knowledge-expansion",
    "text": "You mentioned X, but how does that account for Y?",
    "sample_answer": "Y is actually a special case of X because..."
  }
]
`;

	const provider = settings.provider;
	let apiKey = "";
	if (provider === "gemini") {
		apiKey = settings.geminiApiKey;
	}

	let content = "";
	try {
		if (provider === "gemini") {
			content = await callGemini(prompt, apiKey, settings.model, systemPrompt);
		} else if (provider === "ollama") {
			content = await callOllama(prompt, settings.model, systemPrompt, settings.ollamaBaseUrl);
		}
	} catch (e) {
		console.error("Deep Notes: Failed to generate sub-questions", e);
		return [];
	}

	const items = parseResponse(content);

	// Generate embedding for sample answer
	for (const item of items) {
		if (item.sampleAnswer) {
			try {
				const embedding = await getEmbedding(item.sampleAnswer, settings);
				if (embedding) {
					item.sampleAnswerEmbedding = embedding;
				}
			} catch (e) {
				console.warn("Deep Notes: Failed to generate embedding for sub-question sample answer", e);
			}
		}
	}

	return items;
}
