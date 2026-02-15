# Socratic Sage

An Obsidian plugin that uses AI to generate Socratic questions from your notes, evaluate your understanding, and schedule spaced-repetition reviews on your calendar.

## Features

- **Socratic Question Generation** — Generates 3-5 thought-provoking questions and suggestions from any note using AI
- **Multi-Provider Support** — Works with OpenAI, Anthropic (Claude), and Google Gemini
- **AI-Powered Evaluation** — Submit your responses and get a percentage-based understanding score with per-question feedback
- **Spaced Repetition Scheduling** — Automatically computes a review date based on your score and appends a review reminder to your daily note
- **Calendar Integration** — Works with [Liam Cain's Calendar plugin](https://github.com/liamcain/obsidian-calendar-plugin) to show review dates as dots on your calendar
- **Add to Note** — Append any question and your response directly into your note as a callout block

## How It Works

1. Open a note and click the Socratic Sage ribbon icon (or run the command)
2. Click **Generate Socratic Questions** to get AI-generated questions about your note
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
2. Go to **Settings > Socratic Sage**
3. Select your AI provider (OpenAI, Anthropic, or Gemini)
4. Enter your API key
5. (Optional) Install the [Calendar plugin](https://github.com/liamcain/obsidian-calendar-plugin) to see review dates on your calendar sidebar

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
