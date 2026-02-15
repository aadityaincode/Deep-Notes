import { App, MarkdownView } from "obsidian";
import { StateField, StateEffect } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView } from "@codemirror/view";

// --- Color Palette ---

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
 * Data structure for a highlighted item passed from the view.
 */
interface HighlightData {
    text: string;
    colorIndex: number;
}

// --- CM6 State Field & Effect ---

// Effect to set the current list of highlights
export const setHighlightsEffect = StateEffect.define<HighlightData[]>();

interface HighlightState {
    decorations: DecorationSet;
    items: HighlightData[];
}

export const deepNotesHighlightField = StateField.define<HighlightState>({
    create() {
        return { decorations: Decoration.none, items: [] };
    },
    update(oldState, tr) {
        let items = oldState.items;
        let didWait = false;

        // Check for new effects
        for (const e of tr.effects) {
            if (e.is(setHighlightsEffect)) {
                items = e.value;
                didWait = true; // Signal we changed items
            }
        }

        // If items changed OR doc changed, we re-calculate decorations
        if (didWait || tr.docChanged) {
            return {
                items,
                decorations: buildDecorations(items, tr.newDoc.toString()),
            };
        }

        return oldState;
    },
    provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

/**
 * Build the DecorationSet based on the list of excerpts and document text.
 */
function buildDecorations(items: HighlightData[], docText: string): DecorationSet {
    const builder: { from: number; to: number; decoration: Decoration }[] = [];
    const maskedDoc = maskMarkdownSyntax(docText);

    for (const item of items) {
        // Try on original first
        let range = findExcerpt(docText, item.text);

        // Fallback: Try masked doc with original excerpt (LLM strips formatting)
        if (!range) {
            range = findExcerpt(maskedDoc, item.text);
        }

        // Fallback: Try masked doc with masked excerpt (LLM includes formatting)
        if (!range) {
            range = findExcerpt(maskedDoc, maskMarkdownSyntax(item.text));
        }

        if (range) {
            // Expand range to include surrounding markdown syntax (e.g. **Bold**)
            range = expandRangeToMarkdownSyntax(docText, range);

            const color = HIGHLIGHT_COLORS[item.colorIndex % HIGHLIGHT_COLORS.length];
            const decoration = Decoration.mark({
                attributes: {
                    style: `
                        background-color: ${color.bg}; 
                        border-bottom: 2px solid ${color.border};
                        border-radius: 2px;
                    `,
                    class: "deep-notes-cm6-highlight"
                },
            });
            builder.push({
                from: range.from,
                to: range.to,
                decoration,
            });
        }
    }

    // Sort by position (required by CM6)
    builder.sort((a, b) => a.from - b.from);

    return Decoration.set(builder.map(b => b.decoration.range(b.from, b.to)));
}

// --- Text Matching Logic ---

/**
 * Helper to replace markdown syntax chars with spaces to allow fuzzy matching.
 */
function maskMarkdownSyntax(text: string): string {
    return text.replace(/[*#_\[\]`>~=]/g, " ");
}

/**
 * Expands the matched range to include surrounding markdown formatting characters.
 * E.g. "Bold" -> "**Bold**", "Title" -> "## Title"
 */
function expandRangeToMarkdownSyntax(
    docText: string,
    range: { from: number; to: number }
): { from: number; to: number } {
    let { from, to } = range;

    const isFormattingChar = (char: string) => /[*_=\[\]`~]/.test(char);

    // 1. Expand tight formatting left (e.g. **)
    while (from > 0 && isFormattingChar(docText[from - 1])) {
        from--;
    }

    // 2. Expand tight formatting right (e.g. **)
    while (to < docText.length && isFormattingChar(docText[to])) {
        to++;
    }

    // 3. Check for Heading/List markers (hash or dash followed by space)
    // Look backwards from current 'from' excluding whitespace
    // Simplification: Check immediate preceding string
    const preceding = docText.slice(Math.max(0, from - 10), from);
    const headingMatch = preceding.match(/([#\-]+[ \t]+)$/);
    if (headingMatch) {
        from -= headingMatch[1].length;
    }

    return { from, to };
}

function findExcerpt(
    searchEl: string,
    excerpt: string
): { from: number; to: number } | null {
    if (!excerpt || excerpt.length < 3) return null;

    // 1. Exact match
    let idx = searchEl.indexOf(excerpt);
    if (idx >= 0) return { from: idx, to: idx + excerpt.length };

    // 2. Case-insensitive
    const lower = searchEl.toLowerCase();
    const excerptLower = excerpt.toLowerCase().trim();
    idx = lower.indexOf(excerptLower);
    if (idx >= 0) return { from: idx, to: idx + excerptLower.length };

    // 3. Normalized whitespace
    const normalized = excerptLower.replace(/\s+/g, " ");
    const normalizedDoc = lower.replace(/\s+/g, " ");
    idx = normalizedDoc.indexOf(normalized);

    if (idx >= 0) {
        // Map back indices
        let origIdx = 0;
        let normIdx = 0;

        while (normIdx < idx && origIdx < searchEl.length) {
            if (/\s/.test(searchEl[origIdx])) {
                origIdx++;
                if (normIdx < normalizedDoc.length && normalizedDoc[normIdx] === " ") {
                    normIdx++;
                }
                while (origIdx < searchEl.length && /\s/.test(searchEl[origIdx])) {
                    origIdx++;
                }
            } else {
                origIdx++;
                normIdx++;
            }
        }

        const from = origIdx;

        let matchLen = 0;
        let consumedNorm = 0;

        while (consumedNorm < normalized.length && from + matchLen < searchEl.length) {
            if (/\s/.test(searchEl[from + matchLen])) {
                matchLen++;
            } else {
                matchLen++;
                consumedNorm++;
                while (consumedNorm < normalized.length && normalized[consumedNorm] === " ") {
                    consumedNorm++;
                }
            }
        }
        return { from, to: from + matchLen };
    }

    return null;
}

/**
 * Re-export wrapper. Note: scrollToExcerpt uses this directly, so we might want to apply expansion there too?
 * The user mainly cares about visual highlights. Scroll target is fine if it hits the core text.
 */
export function findExcerptInText(docText: string, excerpt: string) {
    let res = findExcerpt(docText, excerpt);
    if (!res) res = findExcerpt(maskMarkdownSyntax(docText), excerpt);
    return res;
}

// --- Helper Functions ---

/**
 * Find the MarkdownView for the current file.
 * When called from the sidebar, getActiveViewOfType(MarkdownView) returns null
 * because the sidebar is the active leaf. So we search all markdown leaves.
 */
function findMarkdownView(app: App, filePath?: string): MarkdownView | null {
    // Fast path: active leaf IS a markdown view
    const active = app.workspace.getActiveViewOfType(MarkdownView);
    if (active) {
        if (!filePath || active.file?.path === filePath) {
            return active;
        }
    }

    // Determine target path
    const targetPath = filePath || app.workspace.getActiveFile()?.path;
    if (!targetPath) {
        console.log("[DeepNotes] No target path to find MarkdownView for");
        return null;
    }

    // console.log("[DeepNotes] Searching for MarkdownView for file:", targetPath);
    const leaves = app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
        const view = leaf.view as MarkdownView;
        if (view.file?.path === targetPath) {
            // console.log("[DeepNotes] Found matching MarkdownView leaf");
            return view;
        }
    }

    // Last resort: if no path specified, use any open markdown leaf (unlikely to be correct if we have a path)
    if (!filePath && leaves.length > 0) {
        // console.log("[DeepNotes] Fallback to first available MarkdownView");
        return leaves[0].view as MarkdownView;
    }

    console.log(`[DeepNotes] No MarkdownView found for ${targetPath}`);
    return null;
}

export function applyHighlights(
    app: App,
    excerpts: { text: string; colorIndex: number }[],
    filePath?: string
): void {
    console.log(`[DeepNotes] Applying ${excerpts.length} highlights to ${filePath || "active file"}...`);
    const mdView = findMarkdownView(app, filePath);
    if (!mdView) {
        console.log("[DeepNotes] Abort: No MarkdownView found");
        return;
    }

    const editor = mdView.editor as any;
    if (!editor.cm) {
        console.log("[DeepNotes] Abort: No CM instance found on editor");
        return;
    }

    const cm = editor.cm as EditorView;

    cm.dispatch({
        effects: setHighlightsEffect.of(excerpts)
    });
}

export function clearAllHighlights(app?: App, filePath?: string): void {
    if (!app) return;

    const mdView = findMarkdownView(app, filePath);
    if (!mdView) return;

    const editor = mdView.editor as any;
    if (!editor.cm) return;
    const cm = editor.cm as EditorView;

    cm.dispatch({
        effects: setHighlightsEffect.of([])
    });
}

export function scrollToExcerpt(app: App, excerpt: string): void {
    const mdView = findMarkdownView(app);
    if (!mdView) return;

    const editor = mdView.editor;
    const cmView = (editor as any).cm as EditorView;
    if (!cmView) return;

    const docText = cmView.state.doc.toString();
    const range = findExcerptInText(docText, excerpt);
    if (!range) return;

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
