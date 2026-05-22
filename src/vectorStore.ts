import { LocalIndex, MetadataTypes } from "vectra";
import type { App, TFile } from "obsidian";
import { buildRotationSigns, turboQuantize, int8CosineSimilarity } from "./turboQuant";

export interface NoteChunk {
    text: string;
    filePath: string;
    chunkIndex: number;
    heading: string;
}

export interface SearchResult {
    text: string;
    filePath: string;
    noteTitle: string;
    heading: string;
    score: number;
}

interface ChunkMetadata extends Record<string, MetadataTypes> {
    filePath: string;
    chunkIndex: number;
    heading: string;
    text: string;
    mtime: number;
    textHash?: string;
}

function simpleHash(text: string): string {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
        const char = text.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

export class VaultVectorStore {
    private index: LocalIndex;
    private indexPath: string;

    // TurboQuant compressed store: chunk UUID → Int8Array
    private quantizedVectors = new Map<string, Int8Array>();

    // Fixed rotation signs (built once, reused for every vector)
    private readonly rotationSigns: Int8Array;

    constructor(pluginDir: string) {
        this.indexPath = `${pluginDir}/vectors`;
        this.index = new LocalIndex(this.indexPath);
        // 768 = Gemini embedding dim; use 1536 for OpenAI-compatible models
        this.rotationSigns = buildRotationSigns(768, /*seed=*/ 42);
    }

    async initialize(): Promise<void> {
        if (!(await this.index.isIndexCreated())) {
            await this.index.createIndex();
        }
    }

    async indexNote(
        file: TFile,
        content: string,
        embedFn: (text: string) => Promise<number[]>,
        app?: App
    ): Promise<void> {
        const chunks = app ? chunkNoteWithContext(app, file, content) : chunkNote(content, file.path);
        console.debug(`[DeepNotes] Chunked ${file.path} into ${chunks.length} chunks`);

        // Get existing items for hash-based incremental indexing
        const existingItems = await this.index.listItemsByMetadata({ filePath: file.path } as Partial<ChunkMetadata>);
        const existingByChunkIndex = new Map<number, { id: string; textHash?: string }>();
        for (const item of existingItems) {
            const meta = item.metadata as unknown as ChunkMetadata;
            existingByChunkIndex.set(meta.chunkIndex, { id: item.id, textHash: meta.textHash });
        }

        const newChunkIndices = new Set<number>();

        for (const chunk of chunks) {
            newChunkIndices.add(chunk.chunkIndex);
            const textHash = simpleHash(chunk.text);
            const existing = existingByChunkIndex.get(chunk.chunkIndex);

            // Skip unchanged chunks — no API call needed
            if (existing && existing.textHash === textHash) {
                // Re-populate in-memory quantized map if missing (e.g., after restart)
                if (!this.quantizedVectors.has(existing.id)) {
                    // Vector is persisted in Vectra but not in-memory; will fall back to vectraSearch
                }
                continue;
            }

            // Changed or new chunk: remove old if exists
            if (existing) {
                await this.index.deleteItem(existing.id);
                this.quantizedVectors.delete(existing.id);
            }

            const floatVec = await embedFn(chunk.text);
            if (!floatVec || floatVec.length === 0) {
                console.warn(`[DeepNotes] Empty vector for chunk in ${file.path}`);
                continue;
            }

            const signs = floatVec.length !== this.rotationSigns.length
                ? buildRotationSigns(floatVec.length, 42)
                : this.rotationSigns;

            const quantized = turboQuantize(floatVec, signs);

            const { id } = await this.index.insertItem({
                vector: floatVec,
                metadata: {
                    filePath: chunk.filePath,
                    chunkIndex: chunk.chunkIndex,
                    heading: chunk.heading,
                    text: chunk.text,
                    mtime: file.stat.mtime,
                    textHash,
                } as ChunkMetadata,
            });

            this.quantizedVectors.set(id, quantized);
        }

        // Remove stale chunks (chunk count reduced)
        for (const [chunkIndex, { id }] of existingByChunkIndex.entries()) {
            if (!newChunkIndices.has(chunkIndex)) {
                await this.index.deleteItem(id);
                this.quantizedVectors.delete(id);
            }
        }
    }

    async removeNote(filePath: string): Promise<void> {
        const results = await this.index.listItemsByMetadata({
            filePath,
        } as Partial<ChunkMetadata>);

        for (const item of results) {
            await this.index.deleteItem(item.id);
        }
    }

    async clearIndex(): Promise<void> {
        if (await this.index.isIndexCreated()) {
            await this.index.deleteIndex();
            await this.index.createIndex();
        }
    }

    async search(
        queryEmbedding: number[],
        topK: number,
        excludeFilePath?: string
    ): Promise<SearchResult[]> {
        // Quantize the query vector using the same rotation
        const signs = queryEmbedding.length !== this.rotationSigns.length
            ? buildRotationSigns(queryEmbedding.length, 42)
            : this.rotationSigns;
        const queryInt8 = turboQuantize(queryEmbedding, signs);

        // If we have quantized vectors in memory, use fast int8 search
        if (this.quantizedVectors.size > 0) {
            return this.int8Search(queryInt8, topK, excludeFilePath);
        }

        // Fallback: standard Vectra float search (e.g., on first load before warm-up)
        return this.vectraSearch(queryEmbedding, topK, excludeFilePath);
    }

    private async int8Search(queryInt8: Int8Array, topK: number, excludePath?: string): Promise<SearchResult[]> {
        const items = await this.index.listItems();
        const scored: Array<{ score: number; meta: ChunkMetadata }> = [];

        for (const item of items) {
            const meta = item.metadata as unknown as ChunkMetadata;
            if (excludePath && meta.filePath === excludePath) continue;

            const quantized = this.quantizedVectors.get(item.id);
            if (!quantized) continue;

            const score = int8CosineSimilarity(queryInt8, quantized);
            scored.push({ score, meta });
        }

        return scored
            .sort((a, b) => b.score - a.score)
            .slice(0, topK)
            .map(({ score, meta }) => {
                const parts = meta.filePath.split("/");
                return {
                    text: meta.text,
                    filePath: meta.filePath,
                    noteTitle: parts[parts.length - 1].replace(/\.md$/, ""),
                    heading: meta.heading,
                    score,
                };
            });
    }

    private async vectraSearch(queryEmbedding: number[], topK: number, excludePath?: string): Promise<SearchResult[]> {
        const results = await this.index.queryItems(queryEmbedding, "", topK + 5, undefined);
        return results
            .filter(r => {
                const meta = r.item.metadata as unknown as ChunkMetadata;
                return !excludePath || meta.filePath !== excludePath;
            })
            .slice(0, topK)
            .map(r => {
                const meta = r.item.metadata as unknown as ChunkMetadata;
                const parts = meta.filePath.split("/");
                return {
                    text: meta.text,
                    filePath: meta.filePath,
                    noteTitle: parts[parts.length - 1].replace(/\.md$/, ""),
                    heading: meta.heading,
                    score: r.score,
                };
            });
    }

    async isIndexed(filePath: string, mtime: number): Promise<boolean> {
        const results = await this.index.listItemsByMetadata({
            filePath,
        } as Partial<ChunkMetadata>);

        if (results.length === 0) return false;
        const storedMtime = (results[0].metadata as unknown as ChunkMetadata).mtime;
        return storedMtime === mtime;
    }

    async getStats(): Promise<{ totalChunks: number }> {
        const items = await this.index.listItems();
        return { totalChunks: items.length };
    }
}

/**
 * Splits a markdown note into chunks by headings, then by paragraphs if too long.
 * Each chunk is ~300-800 characters.
 */
export function chunkNote(content: string, filePath: string): NoteChunk[] {
    const chunks: NoteChunk[] = [];
    const lines = content.split("\n");

    let currentHeading = "Introduction";
    let currentBlock = "";
    let chunkIndex = 0;

    const pushChunk = (text: string, heading: string) => {
        const trimmed = text.trim();
        if (trimmed.length < 30) return; // skip tiny chunks
        chunks.push({
            text: trimmed,
            filePath,
            chunkIndex: chunkIndex++,
            heading,
        });
    };

    for (const line of lines) {
        const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
        if (headingMatch) {
            // Flush current block
            if (currentBlock.trim()) {
                splitLongBlock(currentBlock, currentHeading, pushChunk);
            }
            currentHeading = headingMatch[2];
            currentBlock = "";
        } else {
            currentBlock += line + "\n";
        }
    }

    // Flush remaining
    if (currentBlock.trim()) {
        splitLongBlock(currentBlock, currentHeading, pushChunk);
    }

    return chunks;
}

function splitLongBlock(
    block: string,
    heading: string,
    pushChunk: (text: string, heading: string) => void
): void {
    if (block.length <= 800) {
        pushChunk(block, heading);
        return;
    }

    // Split by double newline (paragraphs)
    const paragraphs = block.split(/\n\s*\n/);
    let buffer = "";

    for (const para of paragraphs) {
        if (buffer.length + para.length > 800 && buffer.length > 0) {
            pushChunk(buffer, heading);
            buffer = para;
        } else {
            buffer += (buffer ? "\n\n" : "") + para;
        }
    }

    if (buffer.trim()) {
        pushChunk(buffer, heading);
    }
}

export function chunkNoteWithContext(app: App, file: TFile, content: string): NoteChunk[] {
    const cache = app.metadataCache.getFileCache(file);
    const outLinks = cache?.links?.map((l) => l.link.split("#")[0]) ?? [];
    const tags = cache?.tags?.map((t) => t.tag) ?? [];
    const frontmatter = cache?.frontmatter ?? {};

    const metaHeader = [
        `[File: ${file.basename}]`,
        file.parent?.path && file.parent.path !== "/" ? `[Folder: ${file.parent.path}]` : null,
        outLinks.length > 0 ? `[Links: ${outLinks.map((l) => `[[${l}]]`).join(", ")}]` : null,
        tags.length > 0 ? `[Tags: ${tags.join(" ")}]` : null,
        frontmatter.aliases ? `[Aliases: ${(frontmatter.aliases as string[]).join(", ")}]` : null,
    ]
        .filter(Boolean)
        .join(" ");

    const chunks: NoteChunk[] = [];
    const lines = content.split("\n");
    let currentHeading = "Introduction";
    let currentBlock = "";
    let chunkIndex = 0;

    const pushChunk = (text: string, heading: string) => {
        const trimmed = text.trim();
        if (trimmed.length < 30) return;
        const headingPrefix = `[File: ${file.basename}] [Heading: ${heading}]\n${metaHeader}\n`;
        chunks.push({
            text: headingPrefix + trimmed,
            filePath: file.path,
            chunkIndex: chunkIndex++,
            heading,
        });
    };

    for (const line of lines) {
        const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
        if (headingMatch) {
            if (currentBlock.trim()) splitLongBlock(currentBlock, currentHeading, pushChunk);
            currentHeading = headingMatch[2];
            currentBlock = "";
        } else {
            currentBlock += line + "\n";
        }
    }
    if (currentBlock.trim()) splitLongBlock(currentBlock, currentHeading, pushChunk);

    return chunks;
}
