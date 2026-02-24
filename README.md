# TLDR Newsletter Filter

Finds [TLDR newsletter](https://tldr.tech/) articles that match user-defined criteria using [OpenRouter](https://openrouter.ai/). You choose which newsletters to scrape, the date range, the matching criteria, and which AI models to use for evaluation.

## What it does

1. Scrapes TLDR archive pages for the newsletters and date range in your config (only non-sponsor links).
2. For each scraped archive batch, fetches and evaluates all links in that batch concurrently.
3. Each run creates a timestamped directory under `output/` (e.g. `output/2026-02-24_15-30-12/`) and writes `log.json` incrementally as each article is evaluated.
4. At the end of the run, writes `matching_articles.json`, `matching_articles.md`, or both (per `outputFormat`) into the same run directory.

## Evaluation pipeline

- Stage 1 (screener) — Runs when `models.screening` is set. Uses only the article's title and summary to decide if the topic could relate to your criteria. Rejected links are not fetched (saves tokens and time). Omit `models.screening` to skip Stage 1 and send every link to Stage 2.
- Stage 2 (evaluator): The full article is fetched and the main text is extracted, then capped at 100k characters before being sent to the evaluation model, which evaluates the document against your criteria.

## Prerequisites

- Node.js 20+
- An OpenRouter API key ([OpenRouter Settings](https://openrouter.ai/settings/keys))

## Config

Copy the example config and edit it:

```bash
cp config.example.json config.json
```

Set your API key in `.env`:

```
OPENROUTER_API_KEY=your-api-key
```

Config schema (`config.json`):

| Field               | Type     | Description                                                                                                                                                                           |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `newsletters`       | string[] | TLDR slugs to scrape (non-empty). Known slugs: `ai`, `crypto`, `data`, `design`, `dev`, `devops`, `fintech`, `founders`, `hardware`, `infosec`, `it`, `marketing`, `product`, `tech`. |
| `dateRange`         | string[] | One date (YYYY-MM-DD) for a single day, or two dates for start and end (inclusive). Array length must be 1 or 2.                                                                      |
| `criteria`          | string[] | Matching criteria that the article must satisfy. Each array element is a separate criterion string. The app numbers and formats them for prompts and output. Must be non-empty.       |
| `models`            | object   | Model IDs by role. Required.                                                                                                                                                          |
| `models.screening`  | string   | Optional. OpenRouter model ID for Stage 1 summary screening. If omitted, Stage 1 is skipped and every article is fetched and evaluated with the evaluation model.                     |
| `models.evaluation` | string   | OpenRouter model ID for Stage 2 full article evaluation. Required.                                                                                                                    |
| `outputFormat`      | string   | Optional. One of `md`, `json`, or `both`. Defaults to `json` if missing or invalid.                                                                                                   |

## Run

Install dependencies, then start:

```bash
pnpm install
pnpm start
```

Each run writes to a timestamped directory under `output/` (e.g. `output/2026-02-24_15-30-12/`):

- `log.json` — One entry per evaluated URL (matched, not matched, summary rejected (Stage 1), fetch failed, or evaluation failed). Updated incrementally. Previous runs are preserved in their own directories.
- `matching_articles.json` — Written when `outputFormat` is `json` or `both`. Object: `metadata` and `articles`.
- `matching_articles.md` — Written when `outputFormat` is `md` or `both`. A header with run config and generation time, then a bullet list of matches with a reason line per article.

## Project structure

- `src/index.ts` — Entry point and pipeline orchestration.
- `src/pipeline/` — Scraper, article fetcher (with parse worker), evaluator (Stage 1 and Stage 2).
- `src/output/` — Progress log and matching-articles output.
- `src/config.ts`, `src/types.ts`, `src/constants.ts`, `src/utils/` — Config loading, types, shared constants, retry and URL helpers.

## Example

Input (`config.json`):

```json
{
  "newsletters": ["ai", "dev"],
  "dateRange": ["2025-10-07", "2025-10-27"],
  "models": {
    "screening": "google/gemini-2.5-flash-lite",
    "evaluation": "deepseek/deepseek-v3.2"
  },
  "criteria": [
    "It is a first-hand account from a developer or team.",
    "The article states, implies, or supports a reasonable inference that AI coding agents are now so accurate that the human rarely performs manual implementation.",
    "The developer describes in quantitative terms materially faster delivery, higher throughput, or meaningful time savings due to AI assistance."
  ],
  "outputFormat": "json"
}
```

Output (`output/2026-02-24_15-30-12/matching_articles.json`):

```json
{
  "articles": [
    {
      "title": "From 8 years down to 6 months: How we built AI to split the monday.com monolith (9 minute read)",
      "url": "https://engineering.monday.com/from-8-years-down-to-6-months-how-we-built-ai-to-split-the-monday-com-monolith/",
      "date": "2025-10-08",
      "source": "ai",
      "reason": "The article is a first-hand account from developers at monday.com who built and used Morphex, an AI-powered migration system. It clearly demonstrates that AI coding agents are now so accurate that humans rarely perform manual implementation, as Morphex autonomously extracted 1% of the codebase in a single day through automated processes. The article provides clear quantitative productivity gains, showing that a task originally estimated at 8 person-years of manual effort was reduced to just 6 months, with Morphex extracting 1% of the client-side codebase in a single day."
    },
    {
      "title": "Getting DeepSeek-OCR working on an NVIDIA Spark via brute force using Claude Code (10 minute read)",
      "url": "https://simonwillison.net/2025/Oct/20/deepseek-ocr-claude-code/",
      "date": "2025-10-22",
      "source": "dev",
      "reason": "The article is a first-hand account from a developer who used Claude Code to run a DeepSeek OCR model on NVIDIA Spark hardware. It explicitly states that the AI agent handled most of the implementation ('I decided to outsource the entire process to Claude Code'), with the developer only providing four prompts and spending just 5-10 minutes actively involved. The article quantifies productivity gains, noting the entire project took less than 40 minutes start to finish with most time spent waiting while the developer did other things. This demonstrates both rare manual coding and clear time savings."
    }
  ]
}
```
