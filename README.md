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

- `log.json` — The complete execution log, updated incrementally as articles are processed.
  - **`metadata`**: Contains your run configuration alongside execution stats: timestamps, duration, total articles processed, token usage summaries, and final status counts.
  - **`articles`**: A detailed record of every article processed, keyed by its URL. Each entry includes the article's details, its evaluation `status` (e.g., `matched`, `summary_rejected`), the model's `reason` and `analysis`, and the token usage for that specific article.
- `matching_articles.json` — Written when `outputFormat` is `json` or `both`. Object: `metadata` and `articles`.
- `matching_articles.md` — Written when `outputFormat` is `md` or `both`. A header with run config and generation time, then a bullet list of matches with a reason line per article.

## Example

Input (`config.json`):

```json
{
  "newsletters": ["ai", "dev"],
  "dateRange": ["2025-10-01", "2025-10-13"],
  "models": {
    "screening": "google/gemini-2.5-flash-lite",
    "evaluation": "deepseek/deepseek-v3.2"
  },
  "criteria": [
    "The article's primary purpose is sharing real experience or insight, not marketing a product, announcing a launch, or promoting a company's tool or platform. Genuine personal reflections are acceptable even if they mention their company, but the article should not read as promotional content.",
    "It is a first-hand account from an individual person or small team reflecting on their genuine experience, not a corporate blog showcasing an internal tool or platform capability.",
    "The article describes one or more instances of the author using AI coding agents for substantial implementation of their own work. Meta-commentary or industry analysis about AI/LLMs does not satisfy this.",
    "The author provides specific quantitative terms or reasoned estimates describing their own productivity gains from AI coding tools (e.g., time savings, percentage of code written by AI, before/after comparisons, ratio of active involvement to total time, cost savings, scope of work accomplished in a stated timeframe, etc.). General industry statistics, adoption figures, or market data do not count. Vague or impressionistic multipliers (e.g., 10x) also do not qualify."
  ],
  "outputFormat": "json"
}
```

Output (`matching_articles.json`):

```json
{
  "articles": [
    {
      "title": "Real AI Agents and Real Work (7 minute read)",
      "url": "https://www.oneusefulthing.org/p/real-ai-agents-and-real-work",
      "date": "2025-10-01",
      "source": "ai",
      "reason": "The article satisfies all four criteria: it's a genuine personal reflection on AI experiences, written from a first-hand perspective, describes specific AI coding agent implementations for research replication, and provides multiple specific quantitative productivity metrics including time savings estimates and cost/effort percentages.",
      "analysis": "Criterion 1: The article's primary purpose is sharing real experience and insight about AI capabilities and implications for work, not marketing a product. It discusses the author's personal experiments and reflections. Criterion 2: This is a first-hand account from an individual professor sharing genuine experiences with AI testing and replication experiments. Criterion 3: The article describes specific instances where the author used Claude Sonnet 4.5 and GPT-5 Pro to replicate academic research papers by having AI read papers, analyze data, and convert statistical code, which qualifies as using AI coding agents for substantial implementation work. Criterion 4: The author provides specific quantitative metrics including that AI replication \"would have taken many hours\" manually, that following an expert workflow with AI would get work done \"forty percent faster and sixty percent cheaper,\" and references OpenAI's test showing AI performing tasks that take human experts \"four to seven hours.\""
    },
    {
      "title": "Vibing a Non-Trivial Ghostty Feature (16 minute read)",
      "url": "https://mitchellh.com/writing/non-trivial-vibing",
      "date": "2025-10-13",
      "source": "dev",
      "reason": "The document meets all four criteria: it is a genuine personal reflection, a first-hand account, details substantial AI coding agent use, and provides specific quantitative estimates of time and cost related to the author's productivity.",
      "analysis": "Criterion 1: The article's primary purpose is sharing the author's personal experience and process using AI agents to develop a feature, not marketing a product or platform; genuine reflections dominate despite mentions of their own app. Criterion 2: It is a first-hand account from Mitchell Hashimoto, an individual developer, detailing his personal workflow and challenges. Criterion 3: The article describes multiple specific sessions where the author used AI agents to implement substantial parts of the macOS update feature for Ghostty. Criterion 4: The author provides specific quantitative estimates: total token cost ($15.98), total 'wall clock' time spent (~8 hours), and notes working 4 hours a day over 3 days, satisfying the requirement for reasoned estimates of productivity gains."
    }
  ]
}
```
