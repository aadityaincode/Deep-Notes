export const VIEW_TYPE_DEEP_NOTES = "deep-notes-view";

export type AIProvider = "openai" | "anthropic" | "gemini" | "ollama";

export const PROVIDERS: { value: AIProvider; label: string }[] = [
	{ value: "openai", label: "OpenAI" },
	{ value: "anthropic", label: "Anthropic" },
	{ value: "gemini", label: "Google Gemini" },
  { value: "ollama", label: "Ollama (Local)" },
];

export const MODELS_BY_PROVIDER: Record<AIProvider, string[]> = {
	openai: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
	anthropic: ["claude-sonnet-4-5-20250929", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022"],
	gemini: ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-pro"],
  ollama: ["llama3.2:latest", "llama3.2:3b", "qwen2.5:3b", "mistral:7b"],
};

export const DEFAULT_MODEL_BY_PROVIDER: Record<AIProvider, string> = {
	openai: "gpt-4o-mini",
	anthropic: "claude-sonnet-4-5-20250929",
	gemini: "gemini-2.0-flash",
  ollama: "llama3.2:latest",
};

export const DEFAULT_SYSTEM_PROMPT = `You are a thoughtful tutor. Given the content of a user's note, generate 3-5 thoughtful questions and suggestions that encourage deeper thinking about the topic.

Return your response as a JSON array of objects, each with:
- "type": either "question" or "suggestion"
- "text": the question or suggestion text

Example:
[
  {"type": "question", "text": "What assumptions are you making about X?"},
  {"type": "suggestion", "text": "Consider exploring the relationship between X and Y."}
]

Only return the JSON array, no other text.`;

export const EVALUATION_SYSTEM_PROMPT = `You are an expert evaluator assessing a student's understanding of study material based on their responses to generated questions.

You will receive:
1. The original note content (the study material)
2. A list of questions that were asked
3. The student's responses to each question

Evaluate each response for correctness and depth of understanding. Then provide an overall understanding score.

Use this strict rubric:
- Relevance (0-40): Does the response directly address the question and note content?
- Accuracy (0-40): Are claims correct according to the note content?
- Specificity (0-20): Does the response include concrete reasoning/examples instead of vague filler?

Hard rules:
- If a response is profanity-only, abusive, filler (e.g., "idk", "whatever"), nonsense, empty, or clearly off-topic, it MUST be rated "incorrect".
- Non-substantive responses receive 0 for that question.
- If all responses are non-substantive, the overall score must be in the 0-5 range.
- Do not reward tone/politeness; only reward demonstrated understanding.

Return your evaluation as a JSON object with this exact structure:
{
  "score": <number 0-100>,
  "feedback": [
    {
      "question": "<the question text>",
      "rating": "<correct | partial | incorrect>",
      "explanation": "<brief explanation of why this rating was given>"
    }
  ],
  "summary": "<2-3 sentence overall summary of the student's understanding>"
}

Rating guidelines:
- "correct": The response demonstrates strong understanding of the concept
- "partial": The response shows some understanding but is incomplete or slightly inaccurate
- "incorrect": The response shows a misunderstanding or is largely wrong

Only return the JSON object, no other text.`;
