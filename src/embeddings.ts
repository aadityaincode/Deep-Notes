import type { DeepNotesSettings } from "./settings";

export type EmbeddingProvider = "gemini";

async function embedWithGemini(text: string, apiKey: string): Promise<number[]> {
    if (!apiKey) {
        throw new Error("Gemini API key is required but not set.");
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content: { parts: [{ text }] },
        }),
    });

    if (!response.ok) {
        let err = await response.text();
        try {
            // Try to parse JSON error for cleaner message
            const jsonErr = JSON.parse(err);
            if (jsonErr.error && jsonErr.error.message) {
                err = jsonErr.error.message;
            }
        } catch (_) { /* ignore */ }
        throw new Error(`Gemini Embedding API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.embedding?.values ?? [];
}

export async function getEmbedding(
    text: string,
    settings: DeepNotesSettings
): Promise<number[]> {
    // Intentionally ignore settings.embeddingProvider and force Gemini
    // Clean up settings later if needed
    return embedWithGemini(text, settings.geminiApiKey);
}

export function getEmbeddingDimension(): number {
    return 768; // Gemini embedding-001
}
