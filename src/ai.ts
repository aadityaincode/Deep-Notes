import type { AIProvider } from "./constants";
import { EVALUATION_SYSTEM_PROMPT } from "./constants";
import type { SearchResult } from "./vectorStore";

export interface DeepNotesItem {
	type: "knowledge-expansion" | "suggestion" | "cross-topic";
	text: string;
	sourceExcerpt?: string;
	sourceNote?: string;
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
	provider: AIProvider,
	apiKey: string,
	model: string,
	systemPrompt: string,
	ollamaBaseUrl?: string,
	relatedContext?: SearchResult[]
): Promise<DeepNotesItem[]> {
	let userMessage = noteContent;

	if (relatedContext && relatedContext.length > 0) {
		const contextBlock = relatedContext
			.map((r) => `- From "${r.noteTitle}" (${r.heading}): ${r.text}`)
			.join("\n");
		userMessage = `## Current Note\n${noteContent}\n\n## Related Concepts from Other Notes\n${contextBlock}`;
	}

	let content: string;

	switch (provider) {
		case "openai":
			content = await callOpenAI(userMessage, apiKey, model, systemPrompt);
			break;
		case "anthropic":
			content = await callAnthropic(userMessage, apiKey, model, systemPrompt);
			break;
		case "gemini":
			content = await callGemini(userMessage, apiKey, model, systemPrompt);
			break;
		case "ollama":
			content = await callOllama(userMessage, model, systemPrompt, ollamaBaseUrl);
			break;
	}

	return parseResponse(content);
}

async function callOllama(
	noteContent: string,
	model: string,
	systemPrompt: string,
	baseUrl = "http://127.0.0.1:11434"
): Promise<string> {
	const normalizedBase = baseUrl.replace(/\/$/, "");
	const doChat = async (targetModel: string) => {
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
					{ role: "user", content: noteContent },
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

	return { type, text, sourceExcerpt, sourceNote };
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
	systemPrompt: string
): Promise<string> {
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
				{ role: "user", content: noteContent },
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
	systemPrompt: string
): Promise<string> {
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
			messages: [{ role: "user", content: noteContent }],
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
	systemPrompt: string
): Promise<string> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
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
					parts: [{ text: noteContent }],
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
	ollamaBaseUrl?: string
): Promise<string> {
	switch (provider) {
		case "openai":
			return callOpenAI(userMessage, apiKey, model, systemPrompt);
		case "anthropic":
			return callAnthropic(userMessage, apiKey, model, systemPrompt);
		case "gemini":
			return callGemini(userMessage, apiKey, model, systemPrompt);
		case "ollama":
			return callOllama(userMessage, model, systemPrompt, ollamaBaseUrl);
	}
}

export async function evaluateResponses(
	noteContent: string,
	questionsAndResponses: { question: string; response: string }[],
	provider: AIProvider,
	apiKey: string,
	model: string,
	ollamaBaseUrl?: string
): Promise<EvaluationResult> {
	const userMessage = `## Original Note Content
${noteContent}

## Questions and Student Responses
${questionsAndResponses.map((qr, i) => `### Question ${i + 1}
**Q:** ${qr.question}
**Student's Response:** ${qr.response}`).join("\n\n")}`;

	const content = await callProvider(
		userMessage,
		provider,
		apiKey,
		model,
		EVALUATION_SYSTEM_PROMPT,
		ollamaBaseUrl
	);

	const parsed = parseEvaluationResponse(content);
	return enforceEvaluationRubric(parsed, questionsAndResponses);
}

function enforceEvaluationRubric(
	result: EvaluationResult,
	questionsAndResponses: { question: string; response: string }[]
): EvaluationResult {
	if (questionsAndResponses.length === 0) {
		return result;
	}

	const feedback = [...result.feedback];
	let nonSubstantiveCount = 0;

	for (const qa of questionsAndResponses) {
		if (!isNonSubstantiveResponse(qa.response)) {
			continue;
		}

		nonSubstantiveCount += 1;
		const existingIndex = feedback.findIndex((f) => f.question.trim() === qa.question.trim());
		const forcedFeedback: EvaluationFeedback = {
			question: qa.question,
			rating: "incorrect",
			explanation: "Response is non-substantive or off-topic, so it does not demonstrate understanding.",
		};

		if (existingIndex >= 0) {
			feedback[existingIndex] = forcedFeedback;
		} else {
			feedback.push(forcedFeedback);
		}
	}

	if (nonSubstantiveCount === 0) {
		return { ...result, feedback };
	}

	const total = questionsAndResponses.length;
	const validCount = Math.max(0, total - nonSubstantiveCount);
	const cap = validCount === 0 ? 5 : Math.max(10, Math.floor((validCount / total) * 60));
	const score = Math.min(result.score, cap);
	const summary =
		validCount === 0
			? "Responses are non-substantive or off-topic, so understanding is scored very low."
			: result.summary;

	return {
		...result,
		score,
		feedback,
		summary,
	};
}

function isNonSubstantiveResponse(response: string): boolean {
	const trimmed = response.trim();
	if (!trimmed) return true;

	const normalized = trimmed.toLowerCase();
	const fillerPhrases = [
		"idk",
		"i don't know",
		"dont know",
		"not sure",
		"whatever",
		"n/a",
		"na",
		"skip",
		"no idea",
	];

	if (fillerPhrases.some((phrase) => normalized === phrase || normalized.includes(` ${phrase} `))) {
		return true;
	}

	const profanity = ["fuck", "shit", "bitch", "asshole", "wtf"];
	if (profanity.some((word) => normalized.includes(word))) {
		return true;
	}

	const words = normalized.match(/[a-z0-9]+/g) ?? [];
	if (words.length <= 2 || trimmed.length < 8) {
		return true;
	}

	return false;
}

function parseEvaluationResponse(content: string): EvaluationResult {
	const jsonMatch = content.match(/\{[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			return {
				score: typeof parsed.score === "number" ? Math.max(0, Math.min(100, parsed.score)) : 50,
				feedback: Array.isArray(parsed.feedback)
					? parsed.feedback.map((f: Record<string, unknown>) => ({
						question: String(f.question ?? ""),
						rating: (["correct", "partial", "incorrect"].includes(f.rating as string)
							? f.rating
							: "partial") as "correct" | "partial" | "incorrect",
						explanation: String(f.explanation ?? ""),
						suggestedAnswer: typeof f.suggestedAnswer === "string" ? f.suggestedAnswer : undefined,
					}))
					: [],
				summary: String(parsed.summary ?? ""),
			};
		} catch {
			// fall through
		}
	}
	return { score: 0, feedback: [], summary: "Failed to parse evaluation response." };
}
