import { Notice, TFile } from "obsidian";
import type DeepNotesPlugin from "./main";
import { VaultVectorStore } from "./vectorStore";
import { BM25Index } from "./bm25";
import { getEmbedding } from "./embeddings";

export class VaultIndexer {
    private plugin: DeepNotesPlugin;
    private vectorStore: VaultVectorStore;
    private bm25Index: BM25Index;
    private indexing = false;

    constructor(plugin: DeepNotesPlugin, vectorStore: VaultVectorStore, bm25Index: BM25Index) {
        this.plugin = plugin;
        this.vectorStore = vectorStore;
        this.bm25Index = bm25Index;
    }

    get isIndexing(): boolean {
        return this.indexing;
    }

    async warmBM25Index(): Promise<void> {
        const files = this.plugin.app.vault.getMarkdownFiles();
        const BATCH = 20;
        for (let i = 0; i < files.length; i++) {
            try {
                const content = await this.plugin.app.vault.read(files[i]);
                this.bm25Index.addDocument(files[i].path, files[i].basename, content);
            } catch {
                // skip unreadable files
            }
            if ((i + 1) % BATCH === 0) {
                await new Promise(r => window.setTimeout(r, 0));
            }
        }
        console.debug(`[DeepNotes] BM25 warm-up complete: ${files.length} documents`);
    }

    async indexVault(): Promise<void> {
        if (this.indexing) {
            new Notice("Vault indexing is already in progress.");
            return;
        }

        this.indexing = true;
        const files = this.plugin.app.vault.getMarkdownFiles();
        let indexed = 0;
        let skipped = 0;
        let failed = 0;

        new Notice(`Indexing vault: ${files.length} notes found...`);

        try {
            for (const file of files) {
                const alreadyIndexed = await this.vectorStore.isIndexed(
                    file.path,
                    file.stat.mtime
                );

                if (alreadyIndexed) {
                    skipped++;
                    continue;
                }

                try {
                    await this.indexSingleNote(file);
                    indexed++;
                } catch {
                    failed++;
                    console.error(`[DeepNotes] Skipping ${file.path} due to error.`);
                }

                if ((indexed + failed) % 10 === 0) {
                    new Notice(`Indexing... ${indexed + failed}/${files.length - skipped} notes`);
                }
            }

            if (failed > 0) {
                new Notice(
                    `Index complete with errors! ${indexed} success, ${failed} failed. Check console for details.`
                );
            } else {
                new Notice(
                    `Vault indexed! ${indexed} notes indexed, ${skipped} unchanged.`
                );
            }
        } catch (e) {
            new Notice(
                `Indexing error: ${e instanceof Error ? e.message : String(e)}`
            );
        } finally {
            this.indexing = false;
        }
    }

    async indexSingleNote(file: TFile): Promise<void> {
        try {
            console.debug(`[DeepNotes] Indexing: ${file.path}`);
            const content = await this.plugin.app.vault.read(file);
            const embedFn = (text: string) => getEmbedding(text, this.plugin.settings);
            await this.vectorStore.indexNote(file, content, embedFn, this.plugin.app);

            // Update BM25 index
            this.bm25Index.removeDocument(file.path);
            this.bm25Index.addDocument(file.path, file.basename, content);

            console.debug(`[DeepNotes] Indexed ${file.path}`);
        } catch (e) {
            console.error(`[DeepNotes] Failed to index ${file.path}:`, e);
            throw e;
        }
    }
}
