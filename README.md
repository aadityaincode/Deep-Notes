# Deep Notes

An Obsidian plugin that uses AI to generate deep questions from your notes, evaluate your understanding, and schedule spaced-repetition reviews on your calendar.

## Features

- **Deep Question Generation** — Generates 3-5 thought-provoking questions and suggestions from any note using AI
- **Multi-Provider Support** — Works with OpenAI, Anthropic (Claude), and Google Gemini
- **Local Ollama Support** — Run models locally without API keys or billing
- **AI-Powered Evaluation** — Submit your responses and get a percentage-based understanding score with per-question feedback
- **Spaced Repetition Scheduling** — Automatically computes a review date based on your score and appends a review reminder to your daily note
- **Calendar Integration** — Works with [Liam Cain's Calendar plugin](https://github.com/liamcain/obsidian-calendar-plugin) to show review dates as dots on your calendar
- **Add to Note** — Append any question and your response directly into your note as a callout block

## How It Works

1. Open a note and click the Deep Notes ribbon icon (or run the command)
2. Click **Generate Deep Notes Questions** to get AI-generated questions about your note
3. Type your responses in the text areas under each question
4. Click **Evaluate** to get your understanding score and per-question feedback
5. Click **Schedule Review** to add a review reminder to the daily note for the computed date

### Spaced Repetition Intervals

| Score | Review In |
|-------|-----------|
| 90%+  | 14 days   |
| 75-89%| 7 days    |
| 50-74%| 3 days    |
| <50%  | 1 day     |

## Setup

1. Install the plugin in your Obsidian vault
2. Go to **Settings > Deep Notes**
3. Select your AI provider (OpenAI, Anthropic, Gemini, or Ollama Local)
4. Enter your API key (only for cloud providers)
5. (Optional) Install the [Calendar plugin](https://github.com/liamcain/obsidian-calendar-plugin) to see review dates on your calendar sidebar

## Run Locally with Ollama (No API Key)

### Install Ollama

Choose one:

- macOS (Homebrew):

```bash
brew install --cask ollama
```

- Download installer: [https://ollama.com/download](https://ollama.com/download)

### Start Ollama and download a model

1. Start the local Ollama server:

```bash
ollama serve
```

2. In a second terminal, pull a model:

```bash
ollama pull llama3.2:latest
```

3. Verify models installed:

```bash
ollama list
```

### Configure the plugin for local mode

1. In Obsidian plugin settings:
	- Set **AI Provider** to **Ollama (Local)**
	- Set **Ollama Base URL** to `http://127.0.0.1:11434`
	- Set model to one from `ollama list` (recommended: `llama3.2:latest`)
2. Use the plugin normally; no API key is required for Ollama.

### Ollama implementation notes

- The plugin sends local chat requests to `POST /api/chat` on your Ollama server.
- If the configured model is missing (for example `llama3.2:3b`), the plugin automatically tries a local fallback tag such as `llama3.2:latest`.
- If no compatible local model exists, the plugin shows a clear error with the exact `ollama pull` command to run.

## Building from Source

```bash
npm install
npm run build
```

For development with auto-rebuild:

```bash
npm run dev
```

## License

MIT
