import { EvaluatedStatus } from './types.js'
import OpenAI from 'openai'

export type EvaluateResult =
  | { status: 'matched'; reason: string; tokens?: number }
  | { status: 'not_matched'; reason: string; tokens?: number }
  | { status: 'evaluation_failed'; reason: string; tokens?: number }

export type SummaryEvaluateResult =
  | { status: 'passed'; reason: string; tokens?: number }
  | { status: 'rejected'; reason: string; tokens?: number }
  | { status: 'evaluation_failed'; reason: string; tokens?: number }

// Stage 1 screening: Ballpark relevance only. Avoids full-article calls for clearly off-topic items.
const SUMMARY_SYSTEM_INSTRUCTION = `<role>
You are a generous initial screener. Your only job is to filter out articles that are obviously off-topic. When in doubt, pass the article through.
</role>

<constraints>
- You are checking broad topic relevance only, not whether the summary satisfies the criteria.
- Summaries are extremely brief and will almost never contain the specific evidence the criteria ask for. That is expected and OK.
- Never reject an article because the summary lacks specific details, evidence, metrics, accounts, or any particular phrasing. The full article may contain all of these even when the summary does not mention them.
- Your threshold for passing should be very low: if the general subject matter could plausibly relate to what the criteria describe, pass it.
- Only reject articles whose topic is clearly and obviously in a completely different domain (e.g., criteria about software but the article is about cooking recipes).
</constraints>

<output_format>
Return your response as JSON with these exact fields:
{
  "potentially_relevant": boolean,
  "reason": "Brief explanation (1-2 sentences)"
}
</output_format>`

// Stage 2: Grounded but reasonable article evaluator.
const ARTICLE_SYSTEM_INSTRUCTION = `<role>
You are an analytical article evaluator. Your job is to determine if the provided article satisfies the user's criteria based on the text.
</role>

<constraints>
- You are limited to the information provided in the article text. Do not invent facts that are not present in the article.
- Use reasonable deduction and common sense to determine if the facts presented in the article satisfy the intent of the criteria.
- Do not demand exact phrasing or overly literal matches. Synthesize the information in the article to evaluate whether it holistically meets the requirements.
</constraints>

<output_format>
Return your response as JSON with these exact fields:
{
  "satisfies_criteria": boolean,
  "reason": "Concise explanation (1-4 sentences)"
}
</output_format>`

export interface EvaluateOptions {
  model: string
  criteria: string
}

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY

  if (!key) throw new Error('Set OPENROUTER_API_KEY')

  return key
}

let client: OpenAI | null = null

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: getApiKey(), baseURL: 'https://openrouter.ai/api/v1' })
  }

  return client
}

function parseStructuredResponse(text: string | undefined): EvaluateResult {
  if (!text?.trim()) {
    return { status: EvaluatedStatus.evaluation_failed, reason: 'Empty response' }
  }

  let cleaned = text.trim()

  // Model may return JSON wrapped in markdown. Strip fences and extract object for parsing.
  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)

  if (fenceMatch) {
    cleaned = fenceMatch[1].trim()
  }

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')

  if (start !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1)
  }

  try {
    const parsed = JSON.parse(cleaned) as { satisfies_criteria: boolean; reason: string }

    if (parsed.satisfies_criteria === true) {
      return { status: EvaluatedStatus.matched, reason: parsed.reason }
    }

    return { status: EvaluatedStatus.not_matched, reason: parsed.reason }
  } catch {
    const preview = text.slice(0, 200).replace(/\n/g, '\\n')

    return { status: EvaluatedStatus.evaluation_failed, reason: `Invalid JSON: ${preview}` }
  }
}

function parseSummaryResponse(text: string | undefined): SummaryEvaluateResult {
  if (!text?.trim()) {
    return { status: 'evaluation_failed', reason: 'Empty response' }
  }

  let cleaned = text.trim()

  const fenceMatch = cleaned.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)

  if (fenceMatch) cleaned = fenceMatch[1].trim()

  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')

  if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1)

  try {
    const parsed = JSON.parse(cleaned) as { potentially_relevant: boolean; reason: string }

    if (parsed.potentially_relevant === true) {
      return { status: 'passed', reason: parsed.reason }
    }

    return { status: 'rejected', reason: parsed.reason }
  } catch {
    const preview = text.slice(0, 200).replace(/\n/g, '\\n')

    return { status: 'evaluation_failed', reason: `Invalid JSON: ${preview}` }
  }
}

function buildSummaryUserContent(title: string, summary: string, criteria: string): string {
  return `<context>
Title: ${title}

Summary: ${summary}
</context>

<task>
Based on the title and summary above, screen this article for potential relevance.

INSTRUCTIONS:
1. Ask only: "Could this article's general subject matter plausibly relate to the criteria's general subject matter?" If yes, answer true.
2. Critical: You are not checking if the summary satisfies the criteria. You are only checking if the topic is in the right ballpark. The summary will almost never contain the specific evidence, metrics, or phrasing the criteria require — that is expected and fine.
3. When in doubt, answer true. Only answer false if the article is obviously about a completely unrelated topic.

Criteria:
${criteria}
</task>`
}

export async function evaluateSummary(
  title: string,
  summary: string,
  options: EvaluateOptions
): Promise<SummaryEvaluateResult> {
  const client = getClient()
  const userContent = buildSummaryUserContent(title, summary, options.criteria)

  const response = await client.chat.completions.create({
    model: options.model,
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_INSTRUCTION },
      { role: 'user', content: userContent }
    ],
    response_format: { type: 'json_object' }
  })

  const result = parseSummaryResponse(response.choices[0]?.message?.content ?? undefined)
  const tokens = response.usage?.total_tokens

  return { ...result, ...(tokens !== undefined && { tokens }) }
}

function buildUserContent(articleText: string, criteria: string): string {
  // Cap prompt size for the model. The article fetcher may provide more, but truncate here for the evaluation request.
  const raw = articleText.length > 100_000 ? articleText.slice(0, 100_000) + '\n\n[Article truncated.]' : articleText

  return `<context>
${raw}
</context>

<task>
Based on the entire document above, determine if it satisfies the following criteria.

Interpret the criteria reasonably and holistically. Do not reject an article based on an overly literal or pedantic reading of a single requirement if the core intent of the criteria is met.

Criteria:
${criteria}
</task>`
}

export async function evaluateArticle(articleText: string, options: EvaluateOptions): Promise<EvaluateResult> {
  const client = getClient()
  const userContent = buildUserContent(articleText, options.criteria)

  const response = await client.chat.completions.create({
    model: options.model,
    messages: [
      { role: 'system', content: ARTICLE_SYSTEM_INSTRUCTION },
      { role: 'user', content: userContent }
    ],
    response_format: { type: 'json_object' }
  })

  const result = parseStructuredResponse(response.choices[0]?.message?.content ?? undefined)
  const tokens = response.usage?.total_tokens

  return { ...result, ...(tokens !== undefined && { tokens }) }
}
