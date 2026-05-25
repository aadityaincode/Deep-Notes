import { DataAdapter, normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";
import { buildRotationSigns, turboQuantize, int8CosineSimilarity } from "./turboQuant";

// --- Lightweight LocalIndex: replaces vectra, uses Obsidian adapter for file I/O ---

export type MetadataTypes = string | number | boolean | null | undefined;

interface StoredItem<TMetadata extends Record<string, MetadataTypes>> {
    id: string;
    vector: number[];
    metadata: TMetadata;
}

interface IndexData<TMetadata extends Record<string, MetadataTypes>> {
    version: number;
    marker: string;
    items: StoredItem<TMetadata>[];
}

const INDEX_MARKER = "deep-notes-v1";

class LocalIndex<TMetadata extends Record<string, MetadataTypes> = Record<string, MetadataTypes>> {
    private readonly adapter: DataAdapter;
    private readonly folderPath: string;
    private readonly indexFile: string;
    private data: IndexData<TMetadata> | null = null;

    constructor(adapter: DataAdapter, folderPath: string) {
        this.adapter = adapter;
        this.folderPath = folderPath;
        this.indexFile = normalizePath(`${folderPath}/index.json`);
    }

    async isIndexCreated(): Promise<boolean> {
        if (!(await this.adapter.exists(this.indexFile))) return false;
        try {
            const parsed = JSON.parse(await this.adapter.read(this.indexFile)) as IndexData<TMetadata>;
            return parsed.marker === INDEX_MARKER;
        } catch {
            return false;
        }
    }

    async createIndex(): Promise<void> {
        if (!(await this.adapter.exists(this.folderPath))) {
            await this.adapter.mkdir(this.folderPath);
        }
        this.data = { version: 1, marker: INDEX_MARKER, items: [] };
        await this.save();
    }

    async deleteIndex(): Promise<void> {
        if (await this.adapter.exists(this.indexFile)) {
            await this.adapter.remove(this.indexFile);
        }
        this.data = null;
    }

    private async load(): Promise<void> {
        if (this.data) return;
        const raw = await this.adapter.read(this.indexFile);
        this.data = JSON.parse(raw) as IndexData<TMetadata>;
    }

    private async save(): Promise<void> {
        await this.adapter.write(this.indexFile, JSON.stringify(this.data));
    }

    async insertItem(item: { vector: number[]; metadata: TMetadata }): Promise<{ id: string }> {
        await this.load();
        const id = crypto.randomUUID();
        this.data!.items.push({ id, vector: item.vector, metadata: item.metadata });
        await this.save();
        return { id };
    }

    async deleteItem(id: string): Promise<void> {
        await this.load();
        this.data!.items = this.data!.items.filter(i => i.id !== id);
        await this.save();
    }

    async listItems(): Promise<{ id: string; metadata: TMetadata }[]> {
        await this.load();
        return this.data!.items.map(i => ({ id: i.id, metadata: i.metadata }));
    }

    async listItemsByMetadata(filter: Partial<TMetadata>): Promise<{ id: string; metadata: TMetadata }[]> {
        await this.load();
        const entries = Object.entries(filter) as [string, MetadataTypes][];
        return this.data!.items
            .filter(i => entries.every(([k, v]) => i.metadata[k] === v))
            .map(i => ({ id: i.id, metadata: i.metadata }));
    }

    async queryItems(
        queryVector: number[],
        _filter: string,
        topK: number,
        _options: unknown
    ): Promise<{ item: { id: string; metadata: TMetadata }; score: number }[]> {
        await this.load();
        return this.data!.items
            .map(i => ({
                item: { id: i.id, metadata: i.metadata },
                score: floatCosineSimilarity(queryVector, i.vector),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, topK);
    }
}

function floatCosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
}

// --- End LocalIndex ---

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

    constructor(adapter: DataAdapter, pluginDir: string) {
        this.indexPath = normalizePath(`${pluginDir}/vectors`);
        this.index = new LocalIndex(adapter, this.indexPath);
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
