# Contributing to Deep Notes

Thank you for your interest in contributing to Deep Notes! As an open-source Obsidian plugin, we rely on community contributions to make Deep Notes the best Socratic tutor for Obsidian.

This guide outlines our development workflow, standards, and processes for proposing changes.

---

## Table of Contents
1. [Code of Conduct](#1-code-of-conduct)
2. [How Can I Contribute?](#2-how-can-i-contribute)
   - [Reporting Bugs](#reporting-bugs)
   - [Suggesting Enhancements](#suggesting-enhancements)
   - [Pull Requests](#pull-requests)
3. [Local Development Setup](#3-local-development-setup)
   - [Prerequisites](#prerequisites)
   - [Installation](#installation)
   - [Build Commands](#build-commands)
   - [Testing Your Changes in Obsidian](#testing-your-changes-in-obsidian)
4. [Project Structure](#4-project-structure)
5. [Code Style & Best Practices](#5-code-style--best-practices)
   - [Linting and Formatting](#linting-and-formatting)
   - [Obsidian API Conventions](#obsidian-api-conventions)
   - [AI & Token Efficiency](#ai--token-efficiency)
6. [Release Process](#6-release-process)

---

## 1. Code of Conduct

We are committed to providing a welcoming, safe, and inclusive environment. Please be respectful and constructive in all communication, including issues, pull requests, and discussions.

---

## 2. How Can I Contribute?

### Reporting Bugs
Before creating a bug report, please check the [existing issues](https://github.com/buhariE/Deep-Notes/issues) to see if the issue has already been reported.

If you find a new bug:
1. Open an issue on GitHub.
2. Use a clear and descriptive title.
3. Describe the exact steps to reproduce the bug.
4. Include details about your environment (Obsidian version, OS, plugin version, AI provider).
5. Paste any error logs from the Obsidian Developer Console (accessible via `Cmd+Option+I` on macOS or `Ctrl+Shift+I` on Windows/Linux).

### Suggesting Enhancements
We welcome ideas for new features or UX improvements!
1. Open an issue with the "Enhancement" or "Feature Request" label.
2. Describe the feature, why it is useful, and how you envision the user interface or workflow.
3. Be open to feedback and discussion from the maintainers.

### Pull Requests
Ready to submit code? Please follow these steps:
1. **Fork** the repository and create your branch from `main` (e.g., `feature/socratic-improvement` or `fix/ocr-crash`).
2. Make your changes, ensuring they align with our code style and linting rules.
3. Keep your PR focused. Avoid mixing multiple unrelated fixes or features in a single PR.
4. Write descriptive, clean commit messages.
5. Submit the PR to the `main` branch. Document your changes and reference any related issues in the description.

---

## 3. Local Development Setup

### Prerequisites
- [Node.js](https://nodejs.org/) (Version 18 or later is recommended)
- [npm](https://www.npmjs.com/) installed
- [Obsidian](https://obsidian.md/) installed for local testing

### Installation
Clone your fork of the repository and install dependencies:
```bash
git clone https://github.com/<your-username>/Deep-Notes.git
cd Deep-Notes
npm install --legacy-peer-deps
```
> [!NOTE]
> We use `--legacy-peer-deps` due to the older dependencies and specific versions of packages configured in this repository.

### Build Commands
Our build system is powered by `esbuild` configured in [esbuild.config.mjs](file:///Users/noahnguyen/Deep-Notes/esbuild.config.mjs).

- **Development Build (Watch Mode)**:
  ```bash
  npm run dev
  ```
  This builds the plugin into `./main.js` and watches for source code changes, automatically rebuilding when files are saved.

- **Production Build (Minified)**:
  ```bash
  npm run build
  ```
  This creates a minified build of `main.js` with tree-shaking enabled, ready for distribution.

### Testing Your Changes in Obsidian
Because Obsidian plugins cannot easily be unit-tested headlessly, you will need to test your changes manually in a development vault:

1. Create a dummy/test vault in Obsidian (or open an existing one).
2. Create the plugin directory inside your vault's `.obsidian/plugins/` folder:
   ```bash
   mkdir -p /path/to/your/vault/.obsidian/plugins/deep-notes
   ```
3. Copy or symlink the repository files to your test vault's plugin folder. For a smoother experience, build directly into or symlink the build files:
   ```bash
   ln -s /path/to/cloned/Deep-Notes/main.js /path/to/vault/.obsidian/plugins/deep-notes/main.js
   ln -s /path/to/cloned/Deep-Notes/manifest.json /path/to/vault/.obsidian/plugins/deep-notes/manifest.json
   ln -s /path/to/cloned/Deep-Notes/styles.css /path/to/vault/.obsidian/plugins/deep-notes/styles.css
   ```
4. Enable the plugin in **Obsidian Settings > Community Plugins**.
5. To see changes during development, you can reload the plugin:
   - Use the command `Obsidian: Reload app without saving` (hotkey `Cmd+R` / `Ctrl+R` in Obsidian), or
   - Use a community plugin like **Hot Reload** (recommended for automatic refreshes).

---

## 4. Project Structure

A quick overview of the directories and important files:
- **[src/](file:///Users/noahnguyen/Deep-Notes/src)**: Contains all the TypeScript source code.
  - **[main.ts](file:///Users/noahnguyen/Deep-Notes/src/main.ts)**: Entry point that loads settings, registers commands, views, and indexes.
  - **[ai.ts](file:///Users/noahnguyen/Deep-Notes/src/ai.ts)**: AI model communication (Gemini, Ollama, context caching, LLM-as-judge).
  - **[view.ts](file:///Users/noahnguyen/Deep-Notes/src/view.ts)**: Sidebar view and learning suite modules (Socratic, MCQ, Feynman, Flashcards).
  - **[vectorStore.ts](file:///Users/noahnguyen/Deep-Notes/src/vectorStore.ts)** & **[indexer.ts](file:///Users/noahnguyen/Deep-Notes/src/indexer.ts)**: Local vector database and paragraph-level vault indexing.
  - **[turboQuant.ts](file:///Users/noahnguyen/Deep-Notes/src/turboQuant.ts)**: int8 vector compression engine.
  - **[bm25.ts](file:///Users/noahnguyen/Deep-Notes/src/bm25.ts)**: Local keyword retrieval.
  - **[ocr.ts](file:///Users/noahnguyen/Deep-Notes/src/ocr.ts)**: OCR & Vision logic.
- **[styles.css](file:///Users/noahnguyen/Deep-Notes/styles.css)**: Custom styling for the Deep Notes view panel and interactive states.
- **[manifest.json](file:///Users/noahnguyen/Deep-Notes/manifest.json)**: Plugin metadata read by Obsidian.
- **[eslint.config.js](file:///Users/noahnguyen/Deep-Notes/eslint.config.js)**: Configures typescript-eslint and `eslint-plugin-obsidianmd` rules.

---

## 5. Code Style & Best Practices

### Linting and Formatting
We enforce strict linting to ensure quality and consistency. Run the linter before submitting any PR:
```bash
npx eslint src/
```
- **Sentence Case**: We use `eslint-plugin-obsidianmd`'s rule for sentence-case in UI strings. For example, use "Generate questions" instead of "Generate Questions".
- **Brand Names**: Standard brand names like "Gemini" and "Ollama" are whitelisted for specific capitalization cases.

### Obsidian API Conventions
- **Clean Up Resources**: Always register events, intervals, and styles using `this.registerEvent`, `this.registerInterval`, or ensure you properly clean them up in `onunload()`. This prevents memory leaks when plugins are disabled or reloaded.
- **Async Operations**: Avoid blocking the Obsidian main thread. Large indexing tasks should run incrementally in the background without freezing the UI.

### AI & Token Efficiency
Deep Notes uses various optimizations to keep LLM costs low and search fast:
- **Gemini Context Caching**: If you modify queries or prompt construction in `src/ai.ts`, ensure that you maintain the structure required for Gemini context caching (15-minute server-side cache for notes above the minimum token threshold).
- **Incremental Indexing**: Do not trigger full re-indexing of files unless content hashes change.
- **TurboQuant**: Ensure vector quantization changes keep float32 to int8 compression loss below 1% and retain 4× memory/speed benefits.

---

## 6. Release Process

Releases are automated via GitHub Actions:
1. When a new tag (e.g., `1.0.2`) is pushed to the repository, it triggers the [Release Obsidian Plugin](file:///Users/noahnguyen/Deep-Notes/.github/workflows/release.yml) workflow.
2. The workflow builds the plugin and attaches `main.js`, `manifest.json`, and `styles.css` to a new GitHub Release.
