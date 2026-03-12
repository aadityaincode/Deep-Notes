// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
    ...obsidianmd.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tsparser,
            parserOptions: { project: "./tsconfig.json" },
            globals: {
                console: "readonly",
                window: "readonly",
                setTimeout: "readonly",
                btoa: "readonly",
                document: "readonly",
                HTMLElement: "readonly",
                HTMLDivElement: "readonly",
                HTMLInputElement: "readonly",
                HTMLTextAreaElement: "readonly",
                HTMLButtonElement: "readonly",
            },
        },
        rules: {
            // "obsidianmd/sample-names": "off",
            // "no-control-regex": "off",
            "obsidianmd/ui/sentence-case": ["error", {
                brands: [
                    // Default brands (inherited list)
                    "iOS", "iPadOS", "macOS", "Windows", "Android", "Linux",
                    "Obsidian", "Obsidian Sync", "Obsidian Publish",
                    "Google Drive", "Dropbox", "OneDrive", "iCloud Drive",
                    "YouTube", "Slack", "Discord", "Telegram", "WhatsApp", "Twitter", "X",
                    "Readwise", "Zotero", "Excalidraw", "Mermaid",
                    "Markdown", "LaTeX", "JavaScript", "TypeScript", "Node.js",
                    "npm", "pnpm", "Yarn", "Git", "GitHub", "GitLab",
                    "Notion", "Evernote", "Roam Research", "Logseq", "Anki", "Reddit",
                    "VS Code", "Visual Studio Code", "IntelliJ IDEA", "WebStorm", "PyCharm",
                    // Custom brands for this plugin
                    "Gemini", "Ollama", "Deep Notes",
                ],
            }],
        },
    },
]);
