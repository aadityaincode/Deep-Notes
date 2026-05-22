interface BM25Document {
    id: string;
    title: string;
    termFreqs: Map<string, number>;
    docLength: number;
}

export class BM25Index {
    private docs = new Map<string, BM25Document>();
    private avgDocLen = 0;
    private k1 = 1.5;
    private b = 0.75;

    addDocument(filePath: string, title: string, text: string): void {
        const terms = this.tokenize(text);
        const termFreqs = new Map<string, number>();
        for (const term of terms) {
            termFreqs.set(term, (termFreqs.get(term) ?? 0) + 1);
        }
        this.docs.set(filePath, { id: filePath, title, termFreqs, docLength: terms.length });
        this.updateAvgDocLen();
    }

    removeDocument(filePath: string): void {
        this.docs.delete(filePath);
        this.updateAvgDocLen();
    }

    search(query: string, topK: number, excludePath?: string): Array<{ filePath: string; title: string; score: number }> {
        const queryTerms = this.tokenize(query);
        const N = this.docs.size;
        const scores = new Map<string, number>();

        for (const term of queryTerms) {
            let df = 0;
            for (const doc of this.docs.values()) {
                if (doc.termFreqs.has(term)) df++;
            }
            const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

            for (const [path, doc] of this.docs.entries()) {
                if (path === excludePath) continue;
                const tf = doc.termFreqs.get(term) ?? 0;
                if (tf === 0) continue;
                const tfNorm = (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * doc.docLength / this.avgDocLen));
                scores.set(path, (scores.get(path) ?? 0) + idf * tfNorm);
            }
        }

        return [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, topK)
            .map(([filePath, score]) => ({
                filePath,
                title: this.docs.get(filePath)!.title,
                score,
            }));
    }

    get size(): number {
        return this.docs.size;
    }

    private tokenize(text: string): string[] {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter((t) => t.length > 2);
    }

    private updateAvgDocLen(): void {
        let total = 0;
        for (const doc of this.docs.values()) total += doc.docLength;
        this.avgDocLen = this.docs.size > 0 ? total / this.docs.size : 1;
    }
}
