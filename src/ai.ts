import type { AIProvider } from "./constants";
import { EVALUATION_SYSTEM_PROMPT } from "./constants";

export interface SocraticItem {
	type: "question" | "suggestion";
	text: string;
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

export async function generateSocraticQuestions(
	noteContent: string,
	provider: AIProvider,
	apiKey: string,
	model: string,
	systemPrompt: string
): Promise<SocraticItem[]> {
	let content: string;

	switch (provider) {
		case "openai":
			content = await callOpenAI(noteContent, apiKey, model, systemPrompt);
			break;
		case "anthropic":
			content = await callAnthropic(noteContent, apiKey, model, systemPrompt);
			break;
		case "gemini":
			content = await callGemini(noteContent, apiKey, model, systemPrompt);
			break;
	}

	return parseResponse(content);
}

function parseResponse(content: string): SocraticItem[] {
	// Try to extract JSON from the response (handles markdown code fences)
	const jsonMatch = content.match(/\[[\s\S]*\]/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			if (Array.isArray(parsed)) {
				return parsed.map((item: { type?: string; text?: string }) => ({
					type: item.type === "question" ? "question" : "suggestion",
					text: item.text ?? "",
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
	systemPrompt: string
): Promise<string> {
	switch (provider) {
		case "openai":
			return callOpenAI(userMessage, apiKey, model, systemPrompt);
		case "anthropic":
			return callAnthropic(userMessage, apiKey, model, systemPrompt);
		case "gemini":
			return callGemini(userMessage, apiKey, model, systemPrompt);
	}
}

export async function evaluateResponses(
	noteContent: string,
	questionsAndResponses: { question: string; response: string }[],
	provider: AIProvider,
	apiKey: string,
	model: string
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
		EVALUATION_SYSTEM_PROMPT
	);

	return parseEvaluationResponse(content);
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
