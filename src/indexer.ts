import { Notice, TFile } from "obsidian";
import type DeepNotesPlugin from "./main";
import { VaultVectorStore } from "./vectorStore";
import { getEmbedding } from "./embeddings";

export class VaultIndexer {
    private plugin: DeepNotesPlugin;
    private vectorStore: VaultVectorStore;
    private indexing = false;

    constructor(plugin: DeepNotesPlugin, vectorStore: VaultVectorStore) {
        this.plugin = plugin;
        this.vectorStore = vectorStore;
    }

    get isIndexing(): boolean {
        return this.indexing;
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
                } catch (e) {
                    failed++;
                    console.error(`[DeepNotes] Skipping ${file.path} due to error.`);
                }

                // Progress update every 10 notes
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
            console.log(`[DeepNotes] Indexing: ${file.path}`);
            const content = await this.plugin.app.vault.read(file);
            const embedFn = (text: string) =>
                getEmbedding(text, this.plugin.settings);
            await this.vectorStore.indexNote(file, content, embedFn);
            console.log(`[DeepNotes] Automatically indexed ${file.path}`);
        } catch (e) {
            console.error(`[DeepNotes] Failed to index ${file.path}:`, e);
            throw e; // Propagate error to count as failure
        }
    }
}
