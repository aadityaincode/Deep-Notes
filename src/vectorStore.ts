import { LocalIndex, MetadataTypes } from "vectra";
import type { TFile } from "obsidian";

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
}

export class VaultVectorStore {
    private index: LocalIndex;
    private indexPath: string;

    constructor(pluginDir: string) {
        this.indexPath = `${pluginDir}/vectors`;
        this.index = new LocalIndex(this.indexPath);
    }

    async initialize(): Promise<void> {
        if (!(await this.index.isIndexCreated())) {
            await this.index.createIndex();
        }
    }

    async indexNote(
        file: TFile,
        content: string,
        embedFn: (text: string) => Promise<number[]>
    ): Promise<void> {
        // Remove old chunks for this file
        await this.removeNote(file.path);

        const chunks = chunkNote(content, file.path);
        console.log(`[DeepNotes] Chunked ${file.path} into ${chunks.length} chunks`);

        for (const chunk of chunks) {
            const vector = await embedFn(chunk.text);
            if (!vector || vector.length === 0) {
                console.warn(`[DeepNotes] Empty vector for chunk in ${file.path}`);
                continue;
            }
            console.log(`[DeepNotes] Inserting chunk ${chunk.chunkIndex} (vector dim: ${vector.length})`);
            await this.index.insertItem({
                vector,
                metadata: {
                    filePath: chunk.filePath,
                    chunkIndex: chunk.chunkIndex,
                    heading: chunk.heading,
                    text: chunk.text,
                    mtime: file.stat.mtime,
                } as ChunkMetadata,
            });
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
        const results = await this.index.queryItems(queryEmbedding, "", topK + 5, undefined);

        return results
            .filter((r) => {
                const meta = r.item.metadata as unknown as ChunkMetadata;
                return !excludeFilePath || meta.filePath !== excludeFilePath;
            })
            .slice(0, topK)
            .map((r) => {
                const meta = r.item.metadata as unknown as ChunkMetadata;
                const parts = meta.filePath.split("/");
                const noteTitle = parts[parts.length - 1].replace(/\.md$/, "");
                return {
                    text: meta.text,
                    filePath: meta.filePath,
                    noteTitle,
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
