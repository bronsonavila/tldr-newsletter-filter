# TLDR Newsletter Filter

Finds [TLDR newsletter](https://tldr.tech/) articles that match user-defined criteria using [OpenRouter](https://openrouter.ai/). You choose which newsletters to scrape, the date range, the matching criteria, and which AI models to use for evaluation.

## What it does

1. Scrapes TLDR archive pages for the newsletters and date range in your config (only non-sponsor links).
2. For each scraped archive batch, fetches and evaluates all links in that batch concurrently.
3. Writes `output/log.json` incrementally as each article is evaluated.
4. At the end of the run, writes `matching_articles.json`, `matching_articles.md`, or both, per `outputFormat`.

## Evaluation pipeline

- Stage 1 (screener) — Runs when `screeningModel` is set. Uses only the article's title and summary to decide if the topic could relate to your criteria. Rejected links are not fetched (saves tokens and time). Omit `screeningModel` to skip Stage 1 and send every link to Stage 2.
- Stage 2 (evaluator): The full article (capped at 120k characters) is fetched and the main text is extracted (capped at 100k characters). The evaluation model evaluates the document against your criteria.

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

| Field             | Type     | Description                                                                                                                                                                                               |
| ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `newsletters`     | string[] | TLDR slugs to scrape (non-empty).                                                                                                                                                                         |
| `dateStart`       | string   | Start date YYYY-MM-DD.                                                                                                                                                                                    |
| `dateEnd`         | string   | End date YYYY-MM-DD.                                                                                                                                                                                      |
| `criteria`        | string   | Matching criteria that the article must satisfy. Single markdown-formatted string. The app wraps this in a system instruction prompt. Must be non-empty.                                                  |
| `evaluationModel` | string   | OpenRouter model ID for Stage 2 full article evaluation (e.g., `anthropic/claude-sonnet-4.5`). Required.                                                                                                  |
| `screeningModel`  | string   | Optional. OpenRouter model ID for Stage 1 summary screening (e.g., `google/gemini-3-flash-preview`). If omitted, Stage 1 is skipped and every article is fetched and evaluated with the evaluation model. |
| `outputFormat`    | string   | Optional. One of `md`, `json`, or `both`. Defaults to `json` if missing or invalid.                                                                                                                       |

Known TLDR slugs (any string is allowed; these are for reference):

`ai`, `crypto`, `data`, `design`, `dev`, `devops`, `fintech`, `founders`, `hardware`, `infosec`, `it`, `marketing`, `product`, `tech`

## Run

Install dependencies, then start:

```bash
npm install
npm start
```

Output (in `output/`):

- `log.json` — One entry per evaluated URL (matched, not matched, fetch failed, or evaluation failed). Updated incrementally. Each run overwrites it (no resume).
- `matching_articles.json` — Written when `outputFormat` is `json` or `both`. Object: `metadata` (newsletters, dateStart, dateEnd, criteria, generatedAt) and `articles` (array of { title, url, date, source, reason?, summary? }).
- `matching_articles.md` — Written when `outputFormat` is `md` or `both`. A header with run config and generation time, then a bullet list of matches with an optional reason line per article.

## Example

Input (`config.json`):

```json
{
  "newsletters": ["ai", "dev"],
  "dateStart": "2025-10-07",
  "dateEnd": "2025-10-25",
  "evaluationModel": "anthropic/claude-sonnet-4.5",
  "screeningModel": "google/gemini-3-flash-preview",
  "criteria": "The article must satisfy all of the following:\n- Personal Experience: First-hand account from a developer or team.\n- Rarely Writing Manual Code: Strongly implies AI agents now handle most implementation.\n- Clear Productivity Gains: Quantitative delivery, throughput, or time savings from AI.",
  "outputFormat": "both"
}
```

Output (excerpts). JSON (`matching_articles.json`):

```json
{
  "metadata": {
    "newsletters": ["ai", "dev"],
    "dateStart": "2025-10-07",
    "dateEnd": "2025-10-25",
    "criteria": "...",
    "generatedAt": "2026-02-20T12:06:25.218Z"
  },
  "articles": [
    {
      "title": "From 8 years down to 6 months: How we built AI to split the monday.com monolith (9 minute read)",
      "url": "https://engineering.monday.com/from-8-years-down-to-6-months-how-we-built-ai-to-split-the-monday-com-monolith/",
      "date": "2025-10-08",
      "source": "ai",
      "reason": "This is a first-hand account from the monday.com engineering team about building Morphex, an autonomous AI system for codebase migration. It explicitly states that humans moved from manual coding to managing agents, with the AI performing independent implementation across thousands of files. The productivity gains are quantified, reducing an estimated 8-year manual project to just 6 months."
    },
    {
      "title": "Living dangerously with Claude (10 minute read)",
      "url": "https://simonwillison.net/2025/Oct/22/living-dangerously-with-claude/",
      "date": "2025-10-24",
      "source": "dev",
      "reason": "The author provides a first-hand account of using Claude Code in 'YOLO mode' to complete three distinct technical projects in just 48 hours. He describes leaving the agent to solve 'hairy problems' autonomously while he performed other tasks or ate breakfast, essentially outsourcing the manual implementation entirely. The text provides clear productivity gains by citing 5 completed research projects in less than 2 days."
    }
  ]
}
```

Markdown (`matching_articles.md`) starts with a header (newsletters, date range, criteria, generated), then entries like:

```markdown
- 2025-10-08 – [From 8 years down to 6 months: How we built AI to split the monday.com monolith (9 minute read)](https://engineering.monday.com/from-8-years-down-to-6-months-how-we-built-ai-to-split-the-monday-com-monolith/) (ai)
  - This is a first-hand account from the monday.com engineering team about building Morphex, an autonomous AI system for codebase migration. It explicitly states that humans moved from manual coding to managing agents, with the AI performing independent implementation across thousands of files. The productivity gains are quantified, reducing an estimated 8-year manual project to just 6 months.

- 2025-10-24 – [Living dangerously with Claude (10 minute read)](https://simonwillison.net/2025/Oct/22/living-dangerously-with-claude/) (dev)
  - The author provides a first-hand account of using Claude Code in 'YOLO mode' to complete three distinct technical projects in just 48 hours. He describes leaving the agent to solve 'hairy problems' autonomously while he performed other tasks or ate breakfast, essentially outsourcing the manual implementation entirely. The text provides clear productivity gains by citing 5 completed research projects in less than 2 days.
```
