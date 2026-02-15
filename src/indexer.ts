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

                await this.indexSingleNote(file);
                indexed++;

                // Progress update every 10 notes
                if (indexed % 10 === 0) {
                    new Notice(`Indexing... ${indexed}/${files.length - skipped} notes`);
                }
            }

            new Notice(
                `Vault indexed! ${indexed} notes indexed, ${skipped} unchanged.`
            );
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
            const content = await this.plugin.app.vault.read(file);
            const embedFn = (text: string) =>
                getEmbedding(text, this.plugin.settings);
            await this.vectorStore.indexNote(file, content, embedFn);
        } catch (e) {
            console.error(`Failed to index ${file.path}:`, e);
        }
    }
}
