import { MarkdownView, App } from "obsidian";

/**
 * Color palette for question highlights.
 * Each question gets a unique color matching its sidebar card indicator.
 */
export const HIGHLIGHT_COLORS = [
    { bg: "rgba(255, 107, 107, 0.35)", border: "#ff6b6b", name: "red" },
    { bg: "rgba(78, 205, 196, 0.35)", border: "#4ecdc4", name: "teal" },
    { bg: "rgba(255, 217, 61, 0.35)", border: "#ffd93d", name: "yellow" },
    { bg: "rgba(108, 92, 231, 0.35)", border: "#6c5ce7", name: "purple" },
    { bg: "rgba(0, 184, 148, 0.35)", border: "#00b894", name: "green" },
    { bg: "rgba(253, 121, 168, 0.35)", border: "#fd79a8", name: "pink" },
    { bg: "rgba(116, 185, 255, 0.35)", border: "#74b9ff", name: "blue" },
    { bg: "rgba(255, 165, 2, 0.35)", border: "#ffa502", name: "orange" },
];

/**
 * Find the character offset of an excerpt in text.
 * Tries exact match, case-insensitive, and normalized whitespace.
 */
function findExcerptInText(
    docText: string,
    excerpt: string
): { from: number; to: number } | null {
    if (!excerpt || excerpt.length < 3) return null;

    // Exact match
    let idx = docText.indexOf(excerpt);
    if (idx >= 0) return { from: idx, to: idx + excerpt.length };

    // Case-insensitive
    const lower = docText.toLowerCase();
    const excerptLower = excerpt.toLowerCase().trim();
    idx = lower.indexOf(excerptLower);
    if (idx >= 0) return { from: idx, to: idx + excerptLower.length };

    // Normalized whitespace (collapse \n, \t, multi-spaces)
    const normalized = excerptLower.replace(/\s+/g, " ");
    const normalizedDoc = lower.replace(/\s+/g, " ");
    idx = normalizedDoc.indexOf(normalized);
    if (idx >= 0) {
        // Map back to original position — find the nth non-collapsed char
        let origIdx = 0;
        let normIdx = 0;
        while (normIdx < idx && origIdx < docText.length) {
            if (/\s/.test(docText[origIdx])) {
                // Skip extra whitespace in original
                origIdx++;
                if (normIdx < normalizedDoc.length && normalizedDoc[normIdx] === " ") {
                    normIdx++;
                }
                while (origIdx < docText.length && /\s/.test(docText[origIdx])) {
                    origIdx++;
                }
            } else {
                origIdx++;
                normIdx++;
            }
        }
        const from = origIdx;
        // Now consume the matched length
        let matchLen = 0;
        let consumedNorm = 0;
        while (consumedNorm < normalized.length && from + matchLen < docText.length) {
            if (/\s/.test(docText[from + matchLen])) {
                matchLen++;
            } else {
                matchLen++;
                consumedNorm++;
                // Also skip the norm char
                while (consumedNorm < normalized.length && normalized[consumedNorm] === " ") {
                    consumedNorm++;
                }
            }
        }
        return { from, to: from + matchLen };
    }

    return null;
}

// Store active highlight DOM elements so we can remove them
let activeHighlightEls: HTMLElement[] = [];

/**
 * Apply colored highlight overlays to the editor using DOM elements.
 * This is more reliable than CM6 StateField in Obsidian's environment.
 */
export function applyHighlights(
    app: App,
    excerpts: { text: string; colorIndex: number }[]
): void {
    clearAllHighlights();

    const mdView = app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) return;

    const editor = mdView.editor;
    const cmView = (editor as any).cm;
    if (!cmView) return;

    const docText = cmView.state.doc.toString();
    const domEl: HTMLElement = cmView.dom;

    for (const { text, colorIndex } of excerpts) {
        const range = findExcerptInText(docText, text);
        if (!range) continue;

        const color = HIGHLIGHT_COLORS[colorIndex % HIGHLIGHT_COLORS.length];

        // Get line/col from character offset
        const fromLine = cmView.state.doc.lineAt(range.from);
        const toLine = cmView.state.doc.lineAt(range.to);

        // Get the visual coordinates from CM6
        const fromCoords = cmView.coordsAtPos(range.from);
        const toCoords = cmView.coordsAtPos(range.to);

        if (!fromCoords || !toCoords) continue;

        const editorRect = domEl.getBoundingClientRect();
        const scrollerEl = domEl.querySelector(".cm-scroller") as HTMLElement;
        if (!scrollerEl) continue;

        const scrollerRect = scrollerEl.getBoundingClientRect();

        // Single-line highlight
        if (fromLine.number === toLine.number) {
            const el = document.createElement("div");
            el.className = "deep-notes-editor-highlight";
            el.style.cssText = `
				position: absolute;
				left: ${fromCoords.left - scrollerRect.left + scrollerEl.scrollLeft}px;
				top: ${fromCoords.top - scrollerRect.top + scrollerEl.scrollTop}px;
				width: ${toCoords.right - fromCoords.left}px;
				height: ${fromCoords.bottom - fromCoords.top}px;
				background-color: ${color.bg};
				border-bottom: 2px solid ${color.border};
				pointer-events: none;
				z-index: 0;
				border-radius: 2px;
			`;
            scrollerEl.appendChild(el);
            activeHighlightEls.push(el);
        } else {
            // Multi-line: highlight first line, middle lines, last line
            // For simplicity, create one highlight per line
            for (let lineNum = fromLine.number; lineNum <= toLine.number; lineNum++) {
                const line = cmView.state.doc.line(lineNum);
                const lineStart = lineNum === fromLine.number ? range.from : line.from;
                const lineEnd = lineNum === toLine.number ? range.to : line.to;

                const lFromCoords = cmView.coordsAtPos(lineStart);
                const lToCoords = cmView.coordsAtPos(lineEnd);

                if (!lFromCoords || !lToCoords) continue;

                const el = document.createElement("div");
                el.className = "deep-notes-editor-highlight";
                el.style.cssText = `
					position: absolute;
					left: ${lFromCoords.left - scrollerRect.left + scrollerEl.scrollLeft}px;
					top: ${lFromCoords.top - scrollerRect.top + scrollerEl.scrollTop}px;
					width: ${lToCoords.right - lFromCoords.left}px;
					height: ${lFromCoords.bottom - lFromCoords.top}px;
					background-color: ${color.bg};
					border-bottom: 2px solid ${color.border};
					pointer-events: none;
					z-index: 0;
					border-radius: 2px;
				`;
                scrollerEl.appendChild(el);
                activeHighlightEls.push(el);
            }
        }
    }
}

/**
 * Clear all highlight overlays.
 */
export function clearAllHighlights(): void {
    for (const el of activeHighlightEls) {
        el.remove();
    }
    activeHighlightEls = [];
}

/**
 * Scroll to and briefly select the excerpt in the editor.
 */
export function scrollToExcerpt(app: App, excerpt: string): void {
    const mdView = app.workspace.getActiveViewOfType(MarkdownView);
    if (!mdView) return;

    const editor = mdView.editor;
    const cmView = (editor as any).cm;
    if (!cmView) return;

    const docText = cmView.state.doc.toString();
    const range = findExcerptInText(docText, excerpt);
    if (!range) return;

    // Convert char offsets to line/ch for Obsidian's editor API
    const fromLine = cmView.state.doc.lineAt(range.from);
    const toLine = cmView.state.doc.lineAt(range.to);

    editor.setSelection(
        { line: fromLine.number - 1, ch: range.from - fromLine.from },
        { line: toLine.number - 1, ch: range.to - toLine.from }
    );

    editor.scrollIntoView(
        {
            from: { line: fromLine.number - 1, ch: 0 },
            to: { line: toLine.number - 1, ch: range.to - toLine.from },
        },
        true
    );
}
