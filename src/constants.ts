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
  ollama: ["llama3.2:latest", "llava:latest", "llama3.2:3b", "qwen2.5:3b", "mistral:7b"],
};

export const DEFAULT_MODEL_BY_PROVIDER: Record<AIProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-sonnet-4-5-20250929",
  gemini: "gemini-2.0-flash",
  ollama: "llama3.2:latest",
};

// Default system prompt for generating Deep Notes items
export const DEFAULT_SYSTEM_PROMPT = `
You are a Socratic tutor designed to help users deepen their understanding of their notes.
Your goal is to generate exactly 6 items based on the user's note and any provided related context.

You will receive:
1. The Current Note Content.
2. "Related Concepts from Other Notes" (optional) - potential connections to other files in the user's vault.

Output exactly 6 items in this order:
1-2. Two (2) "knowledge-expansion" questions: Probing questions about the CURRENT note's topic.
3-4. Two (2) "suggestion" items: Actionable ideas for improving or expanding the current note.
5-6. Two (2) "cross-topic" questions: Questions that connect the *current* note's concepts with the *related* concepts provided. 
   - CRITICAL: If no related context is provided, or if the connection is weak, REPLACE these with 2 more knowledge-expansion questions instead.

Return the response as a valid JSON array of objects.
Each object MUST have:
- "type": "knowledge-expansion", "suggestion", or "cross-topic"
- "text": The content of the question or suggestion.
- "sample_answer": A concise, ideal answer to the question (or rationale for the suggestion). This is CRITICAL for evaluation.
- "source_excerpt": The exact, verbatim quote from the note that inspired this question. This is used to highlight the text in the note.
- "sourceNote": (Only for "cross-topic") The title of the related note you are connecting to.

Example:
[
  {
    "type": "knowledge-expansion", 
    "text": "How does the concept of 'entropy' here relate to information theory?",
    "sample_answer": "In both fields, entropy measures uncertainty. In thermodynamics, it's energy unavailable for work; in information theory, it's the surprise in a message.",
    "source_excerpt": "entropy is a measure of the disorder of a system"
  },
  {
    "type": "suggestion",
    "text": "Consider adding a section on the 'Heat Death of the Universe'.",
    "sample_answer": "This provides a concrete application of the second law of thermodynamics.",
    "source_excerpt": "The second law of thermodynamics states that the total entropy of an isolated system can never decrease"
  },
  {
    "type": "cross-topic",
    "text": "How does the 'feedback loop' discussed here relate to the 'Control Systems' note?",
    "sample_answer": "Both notes describe homeostatic mechanisms, but this note focuses on biological feedback while Control Systems focuses on mechanical PID loops.",
    "sourceNote": "Control Systems",
    "source_excerpt": "biological systems maintain homeostasis through negative feedback loops"
  }
]
`;

export const IMAGE_SCAN_SYSTEM_PROMPT = `
You are a visual analyst and Socratic tutor.
Analyze the provided images and the context from the note.
Generate 5 items that help the user understand the visual content (diagrams, charts, formulas).

Return the response as a valid JSON array of objects.
Each object MUST have:
- "type": "question"
- "text": The content of the question.
- "sample_answer": "A concise, ideal answer based on the visual evidence."

Example:
[
  {
    "type": "question",
    "text": "What is the relationship between the X and Y axes in the provided graph?",
    "sample_answer": "The X axis represents time \`t\` and the Y axis represents velocity \`v\`. The positive slope indicates constant acceleration."
  }
]
`;

// Returns the appropriate system prompt for the selected AI provider
export function getSystemPrompt(provider: string): string {
  if (provider === "ollama") {
    // Ollama models need explicit instructions for verbatim quoting
    return `${DEFAULT_SYSTEM_PROMPT}\n\nIMPORTANT: For 'source_excerpt', always copy the exact phrase from the note, without paraphrasing or summarizing. If unsure, quote the full sentence. Do not invent or reword the excerpt. If you cannot find a relevant excerpt, return the full sentence or paragraph from the note.`;
  }
  // Default prompt for other providers
  return DEFAULT_SYSTEM_PROMPT;
}


