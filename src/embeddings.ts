import { requestUrl } from "obsidian";
import type { DeepNotesSettings } from "./settings";

export type EmbeddingProvider = "gemini" | "ollama";

interface GeminiEmbeddingResponse {
    embedding?: { values?: number[] };
    error?: { message?: string };
}

interface OllamaEmbeddingResponse {
    embedding?: number[];
}

async function embedWithGemini(text: string, apiKey: string): Promise<number[]> {
    if (!apiKey) {
        throw new Error("Gemini API key is required but not set.");
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`;
    const response = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content: { parts: [{ text }] },
        }),
    });

    if (response.status !== 200) {
        let err = response.text;
        try {
            // Try to parse JSON error for cleaner message
            const jsonErr = response.json as GeminiEmbeddingResponse;
            if (jsonErr.error?.message) {
                err = jsonErr.error.message;
            }
        } catch { /* ignore */ }
        throw new Error(`Gemini Embedding API error (${response.status}): ${err}`);
    }

    return (response.json as GeminiEmbeddingResponse).embedding?.values ?? [];
}

async function embedWithOllama(
    text: string,
    model: string,
    baseUrl: string
): Promise<number[]> {
    const normalizedBase = baseUrl.replace(/\/$/, "");
    const url = `${normalizedBase}/api/embeddings`;

    const response = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: model,
            prompt: text,
        }),
    });

    if (response.status !== 200) {
        const err = response.text;
        // Handle model not found error gracefully
        if (response.status === 404 && /not found/i.test(err)) {
            throw new Error(
                `Ollama model "${model}" was not found locally. Run: ollama pull ${model}`
            );
        }
        throw new Error(`Ollama Embedding API error (${response.status}): ${err}`);
    }

    const data = response.json as OllamaEmbeddingResponse;
    if (!data.embedding || !Array.isArray(data.embedding)) {
        throw new Error("Ollama response missing 'embedding' array.");
    }
    return data.embedding;
}

export async function getEmbedding(
    text: string,
    settings: DeepNotesSettings
): Promise<number[]> {
    if (settings.embeddingProvider === "ollama") {
        return embedWithOllama(
            text,
            settings.ollamaEmbeddingModel || "nomic-embed-text",
            settings.ollamaBaseUrl || "http://127.0.0.1:11434"
        );
    }

    // Default to Gemini
    return embedWithGemini(text, settings.geminiApiKey);
}
