import type { SocraticSageSettings } from "./settings";

export type EmbeddingProvider = "transformers" | "gemini";

// Singleton for the Transformers.js pipeline
let pipelineInstance: any = null;
let pipelineLoading: Promise<any> | null = null;

async function getTransformersPipeline(): Promise<any> {
    if (pipelineInstance) return pipelineInstance;
    if (pipelineLoading) return pipelineLoading;

    pipelineLoading = (async () => {
        const { pipeline } = await import("@xenova/transformers");
        pipelineInstance = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
        return pipelineInstance;
    })();

    return pipelineLoading;
}

async function embedWithTransformers(text: string): Promise<number[]> {
    const extractor = await getTransformersPipeline();
    const output = await extractor(text, { pooling: "mean", normalize: true });
    return Array.from(output.data as Float32Array);
}

async function embedWithGemini(text: string, apiKey: string): Promise<number[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;
    const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content: { parts: [{ text }] },
        }),
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Gemini Embedding API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    return data.embedding?.values ?? [];
}

export async function getEmbedding(
    text: string,
    settings: SocraticSageSettings
): Promise<number[]> {
    const provider: EmbeddingProvider = settings.embeddingProvider;
    switch (provider) {
        case "transformers":
            return embedWithTransformers(text);
        case "gemini":
            if (!settings.geminiApiKey) {
                throw new Error("Gemini API key required for Gemini embeddings.");
            }
            return embedWithGemini(text, settings.geminiApiKey);
        default: {
            const _exhaustive: never = provider;
            throw new Error(`Unknown embedding provider: ${_exhaustive}`);
        }
    }
}

export function getEmbeddingDimension(provider: EmbeddingProvider): number {
    switch (provider) {
        case "transformers":
            return 384;
        case "gemini":
            return 768;
    }
}
