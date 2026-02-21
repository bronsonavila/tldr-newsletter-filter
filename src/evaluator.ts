import { EvaluatedStatus } from './types.js'
import OpenAI from 'openai'

// Public Types and Options

export type EvaluateResult =
  | { status: 'matched'; reason: string; tokens?: number }
  | { status: 'not_matched'; reason: string; tokens?: number }
  | { status: 'evaluation_failed'; reason: string; tokens?: number }

export type SummaryEvaluateResult =
  | { status: 'passed'; reason: string; tokens?: number }
  | { status: 'rejected'; reason: string; tokens?: number }
  | { status: 'evaluation_failed'; reason: string; tokens?: number }

export interface EvaluateOptions {
  model: string
  criteria: string
}

// System Instructions

// Stage 1 screening: Ballpark relevance only. Avoids full-article calls for clearly off-topic items.
const SUMMARY_SYSTEM_INSTRUCTION = `<role>
You are a generous initial screener. Your only job is to filter out articles that are obviously off-topic. When in doubt, pass the article through.
</role>

<constraints>
- Check broad topic relevance only. Do not judge whether the summary satisfies the criteria.
- Summaries are brief and lossy and often omit what the criteria ask for. Do not reject for missing details, evidence, or different emphasis. The full article may contain it.
- Pass if the subject could plausibly relate to the criteria's domain. Reject only when the topic is clearly unrelated (e.g., software criteria vs. cooking article). When uncertain, pass.
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

// API Client

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

// Response Parsing

type BooleanParseResult<T> = { status: T; reason: string } | { status: 'evaluation_failed'; reason: string }

function parseBooleanJsonResponse<T extends string>(
  text: string | undefined,
  options: { trueStatus: T; falseStatus: T; field: string }
): BooleanParseResult<T> {
  if (!text?.trim()) {
    return { status: 'evaluation_failed', reason: 'Empty response' }
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
    const parsed = JSON.parse(cleaned) as Record<string, unknown>
    const value = parsed[options.field]
    const reason = typeof parsed.reason === 'string' ? parsed.reason : ''

    if (value === true) {
      return { status: options.trueStatus, reason }
    }

    return { status: options.falseStatus, reason }
  } catch {
    const preview = (text ?? '').slice(0, 200).replace(/\n/g, '\\n')

    return { status: 'evaluation_failed', reason: `Invalid JSON: ${preview}` }
  }
}

function parseStructuredResponse(text: string | undefined): EvaluateResult {
  return parseBooleanJsonResponse(text, {
    field: 'satisfies_criteria',
    trueStatus: EvaluatedStatus.matched,
    falseStatus: EvaluatedStatus.not_matched
  }) as EvaluateResult
}

function parseSummaryResponse(text: string | undefined): SummaryEvaluateResult {
  return parseBooleanJsonResponse(text, {
    field: 'potentially_relevant',
    trueStatus: 'passed',
    falseStatus: 'rejected'
  }) as SummaryEvaluateResult
}

// User Content Builders

function buildSummaryUserContent(title: string, summary: string, criteria: string): string {
  return `<context>
Title: ${title}

Summary: ${summary}
</context>

<task>
Based on the title and summary above, screen this article for potential relevance.

INSTRUCTIONS:
Ask only: "Could this article's subject matter plausibly relate to the criteria's domain?" If yes, answer true. You are not judging whether the summary satisfies the criteria – only ballpark topic relevance. Do not reject for missing details or different emphasis. When in doubt, answer true. Answer false only if the topic is obviously unrelated.

Criteria:
${criteria}
</task>`
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

// Evaluation Orchestration

async function evaluateWithInstructions<T extends { status: string; reason: string }>(options: {
  model: string
  systemInstruction: string
  userContent: string
  parse: (content: string | undefined) => T
}): Promise<T & { tokens?: number }> {
  const client = getClient()

  const response = await client.chat.completions.create({
    model: options.model,
    messages: [
      { role: 'system', content: options.systemInstruction },
      { role: 'user', content: options.userContent }
    ],
    response_format: { type: 'json_object' }
  })

  const result = options.parse(response.choices[0]?.message?.content ?? undefined)
  const tokens = response.usage?.total_tokens

  return { ...result, ...(tokens !== undefined && { tokens }) }
}

// Public Entry Points

export async function evaluateSummary(
  title: string,
  summary: string,
  options: EvaluateOptions
): Promise<SummaryEvaluateResult> {
  const userContent = buildSummaryUserContent(title, summary, options.criteria)

  return evaluateWithInstructions({
    model: options.model,
    systemInstruction: SUMMARY_SYSTEM_INSTRUCTION,
    userContent,
    parse: parseSummaryResponse
  })
}

export async function evaluateArticle(articleText: string, options: EvaluateOptions): Promise<EvaluateResult> {
  const userContent = buildUserContent(articleText, options.criteria)

  return evaluateWithInstructions({
    model: options.model,
    systemInstruction: ARTICLE_SYSTEM_INSTRUCTION,
    userContent,
    parse: parseStructuredResponse
  })
}
