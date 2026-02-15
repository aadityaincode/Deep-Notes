import type { DeepNotesItem, EvaluationResult } from "./ai";
import type DeepNotesPlugin from "./main";

export interface QASession {
    id: string;
    notePath: string;
    noteTitle: string;
    timestamp: number;
    items: DeepNotesItem[];
    responses: string[];
    evaluation?: EvaluationResult;
}

const MAX_SESSIONS = 50;

export async function saveSession(
    plugin: DeepNotesPlugin,
    session: QASession
): Promise<void> {
    const history = plugin.settings.history ?? [];
    history.unshift(session);

    // Cap at MAX_SESSIONS
    if (history.length > MAX_SESSIONS) {
        history.length = MAX_SESSIONS;
    }

    plugin.settings.history = history;
    await plugin.saveSettings();
}

export function getSessionsForNote(
    plugin: DeepNotesPlugin,
    notePath: string
): QASession[] {
    return (plugin.settings.history ?? []).filter(
        (s) => s.notePath === notePath
    );
}

export async function deleteSession(
    plugin: DeepNotesPlugin,
    id: string
): Promise<void> {
    plugin.settings.history = (plugin.settings.history ?? []).filter(
        (s) => s.id !== id
    );
    await plugin.saveSettings();
}
