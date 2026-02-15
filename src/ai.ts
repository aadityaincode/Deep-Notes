import type { AIProvider } from "./constants";
import { EVALUATION_SYSTEM_PROMPT } from "./constants";
import type { SearchResult } from "./vectorStore";

export interface DeepNotesItem {
	type: "knowledge-expansion" | "suggestion" | "cross-topic";
	text: string;
	sourceNote?: string;
}

export interface EvaluationFeedback {
	question: string;
	rating: "correct" | "partial" | "incorrect";
	explanation: string;
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
	// Try to extract JSON from the response (handles markdown code fences)
	const jsonMatch = content.match(/\[[\s\S]*\]/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			if (Array.isArray(parsed)) {
				return parsed.map((item: { type?: string; text?: string; sourceNote?: string }) => ({
					type: item.type === "knowledge-expansion" || item.type === "question"
						? "knowledge-expansion"
						: item.type === "cross-topic"
							? "cross-topic"
							: "suggestion",
					text: item.text ?? "",
					sourceNote: item.sourceNote,
				}));
			}
		} catch {
			// fall through
		}
	}

	return [{ type: "suggestion", text: content.trim() }];
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
