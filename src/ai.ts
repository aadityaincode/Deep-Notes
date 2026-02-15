import type { AIProvider } from "./constants";
import type { SearchResult } from "./vectorStore";
import type { ImagePayload } from "./ocr";
import type { DeepNotesSettings } from "./settings";
import { getEmbedding } from "./embeddings";

export interface DeepNotesItem {
	type: "knowledge-expansion" | "suggestion" | "cross-topic";
	text: string;
	sourceExcerpt?: string;
	sourceNote?: string;
	sampleAnswer?: string;
	sampleAnswerEmbedding?: number[];
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

export async function generateDeepNotesQuestions(
	noteContent: string,
	settings: DeepNotesSettings,
	systemPrompt: string,
	relatedContext?: SearchResult[],
	images?: ImagePayload[]
): Promise<DeepNotesItem[]> {
	let userMessage = noteContent;

	if (relatedContext && relatedContext.length > 0) {
		const contextBlock = relatedContext
			.map((r) => `- From "${r.noteTitle}" (${r.heading}): ${r.text}`)
			.join("\n");
		userMessage = `## Current Note\n${noteContent}\n\n## Related Concepts from Other Notes\n${contextBlock}`;
	}

	const imgs = images && images.length > 0 ? images : undefined;
	let content: string;
	const provider = settings.provider;
	const apiKey = provider === "gemini" ? settings.geminiApiKey : (provider === "anthropic" ? settings.anthropicApiKey : settings.apiKey);
	const model = settings.model;
	const ollamaBaseUrl = settings.ollamaBaseUrl;

	switch (provider) {
		case "openai":
			content = await callOpenAI(userMessage, apiKey, model, systemPrompt, imgs);
			break;
		case "anthropic":
			content = await callAnthropic(userMessage, apiKey, model, systemPrompt, imgs);
			break;
		case "gemini":
			content = await callGemini(userMessage, apiKey, model, systemPrompt, imgs);
			break;
		case "ollama":
			content = await callOllama(userMessage, model, systemPrompt, ollamaBaseUrl, imgs);
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
		return fetch(`${normalizedBase}/api/chat`, {
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
	if (!response.ok) {
		const err = await response.text();
		if (response.status === 404 && /not found/i.test(err)) {
			const fallbackModel = await findOllamaFallbackModel(model, normalizedBase);
			if (fallbackModel) {
				response = await doChat(fallbackModel);
				if (response.ok) {
					const data = await response.json();
					return data.message?.content ?? "";
				}
			}

			throw new Error(
				`Ollama model "${model}" was not found locally. Try model "${model.split(":")[0]}:latest" or run: ollama pull ${model}`
			);
		}

		throw new Error(`Ollama API error (${response.status}): ${err}`);
	}

	const data = await response.json();
	return data.message?.content ?? "";
}

async function findOllamaFallbackModel(model: string, normalizedBase: string): Promise<string | null> {
	try {
		const tagsResponse = await fetch(`${normalizedBase}/api/tags`);
		if (!tagsResponse.ok) {
			return null;
		}

		const tagsData = await tagsResponse.json();
		const modelNames: string[] = Array.isArray(tagsData.models)
			? tagsData.models.map((m: { name?: string }) => m.name ?? "").filter(Boolean)
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
			const parsed = JSON.parse(cleaned);
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
		.replace(/[\x00-\x1F\x7F]/g, (c) => (["\r", "\n", "\t"].includes(c) ? c : ""));
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

	const rawType = String(item.type ?? item.kind ?? item.category ?? "").toLowerCase();
	const type: DeepNotesItem["type"] =
		rawType === "knowledge-expansion" || rawType === "question"
			? "knowledge-expansion"
			: rawType === "cross-topic"
				? "cross-topic"
				: "suggestion";

	const sourceExcerpt =
		typeof item.sourceExcerpt === "string"
			? item.sourceExcerpt
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

	return { type, text, sourceExcerpt, sourceNote, sampleAnswer };
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
		return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
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

			const label = line.match(/^(?:q(?:uestion)?\s*\d*[:.-]|suggestion\s*\d*[:.-])\s*(.+)$/i);
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

async function callOpenAI(
	noteContent: string,
	apiKey: string,
	model: string,
	systemPrompt: string,
	images?: ImagePayload[]
): Promise<string> {
	// Build user content: text + optional images
	let userContent: unknown;
	if (images && images.length > 0) {
		const parts: unknown[] = images.map((img) => ({
			type: "image_url",
			image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
		}));
		parts.push({ type: "text", text: noteContent });
		userContent = parts;
	} else {
		userContent = noteContent;
	}

	const response = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userContent },
			],
			temperature: 0.7,
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`OpenAI API error (${response.status}): ${err}`);
	}

	const data = await response.json();
	return data.choices?.[0]?.message?.content ?? "";
}

async function callAnthropic(
	noteContent: string,
	apiKey: string,
	model: string,
	systemPrompt: string,
	images?: ImagePayload[]
): Promise<string> {
	// Build user content blocks: images first, then text
	let contentBlocks: unknown;
	if (images && images.length > 0) {
		const parts: unknown[] = images.map((img) => ({
			type: "image",
			source: {
				type: "base64",
				media_type: img.mimeType,
				data: img.base64,
			},
		}));
		parts.push({ type: "text", text: noteContent });
		contentBlocks = parts;
	} else {
		contentBlocks = noteContent;
	}

	const response = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"anthropic-dangerous-direct-browser-access": "true",
		},
		body: JSON.stringify({
			model,
			max_tokens: 1024,
			system: systemPrompt,
			messages: [{ role: "user", content: contentBlocks }],
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`Anthropic API error (${response.status}): ${err}`);
	}

	const data = await response.json();
	const block = data.content?.[0];
	return block?.text ?? "";
}

async function callGemini(
	noteContent: string,
	apiKey: string,
	model: string,
	systemPrompt: string,
	images?: ImagePayload[]
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

	const response = await fetch(url, {
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
			generationConfig: { temperature: 0.7 },
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`Gemini API error (${response.status}): ${err}`);
	}

	const data = await response.json();
	return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function callProvider(
	userMessage: string,
	provider: AIProvider,
	apiKey: string,
	model: string,
	systemPrompt: string,
	ollamaBaseUrl?: string,
	images?: ImagePayload[]
): Promise<string> {
	switch (provider) {
		case "openai":
			return callOpenAI(userMessage, apiKey, model, systemPrompt, images);
		case "anthropic":
			return callAnthropic(userMessage, apiKey, model, systemPrompt, images);
		case "gemini":
			return callGemini(userMessage, apiKey, model, systemPrompt, images);
		case "ollama":
			return callOllama(userMessage, model, systemPrompt, ollamaBaseUrl, images);
	}
}

export async function evaluateResponses(
	noteContent: string,
	items: DeepNotesItem[],
	userResponses: string[],
	settings: DeepNotesSettings,
	model: string, // Kept for signature compatibility, though unused
	ollamaBaseUrl?: string // Kept for signature compatibility
): Promise<EvaluationResult> {
	const feedback: EvaluationFeedback[] = [];
	let totalScore = 0;
	let validResponsesCount = 0;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const response = userResponses[i] || "";
		let similarityScore = 0;
		let rating: "correct" | "partial" | "incorrect" = "incorrect";
		let explanation = "No response provided.";

		// Calculate similarity if we have both embeddings
		if (item.sampleAnswerEmbedding && response.trim().length > 3) {
			try {
				const userEmbedding = await getEmbedding(response, settings);
				if (userEmbedding && userEmbedding.length > 0) {
					similarityScore = cosineSimilarity(item.sampleAnswerEmbedding, userEmbedding);
				}
			} catch (e) {
				console.warn("Deep Notes: Failed to generate embedding for user response", e);
			}
		}

		// Grading Logic (Pure Vector Similarity)
		if (response.trim().length > 3) {
			const similarityPercent = Math.round(similarityScore * 100);
			totalScore += similarityPercent;

			// We keep the rating string for UI color coding, but the score is now the raw percentage
			if (similarityScore >= 0.85) {
				rating = "correct";
			} else if (similarityScore >= 0.70) {
				rating = "partial";
			} else {
				rating = "incorrect";
			}

			explanation = `Similarity: ${similarityPercent}%`;
			validResponsesCount++;
		} else {
			explanation = "No response provided.";
		}

		feedback.push({
			question: item.text,
			rating,
			explanation,
			suggestedAnswer: item.sampleAnswer // Include the sample answer for reference
		});
	}

	const finalScore = validResponsesCount > 0 ? Math.round(totalScore / items.length) : 0;

	let summary = "";
	if (finalScore >= 90) summary = "Outstanding! You have a deep understanding of this material.";
	else if (finalScore >= 70) summary = "Great job! You grasped most concepts well.";
	else if (finalScore >= 50) summary = "Good start. Review the partial matches to deepen your understanding.";
	else summary = "Keep practicing. Focus on the core concepts and try again.";

	return {
		score: finalScore,
		feedback,
		summary
	};
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
