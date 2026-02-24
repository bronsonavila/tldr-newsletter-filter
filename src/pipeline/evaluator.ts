import OpenAI from 'openai'
import { MAX_BACKOFF_MS, MAX_PROMPT_LENGTH, MAX_RETRIES } from '../constants.js'
import { EVALUATED_STATUS } from '../types.js'
import { delay, RETRYABLE_STATUS_CODES } from '../utils/retry.js'

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

// Stage 1 screening: Ballpark relevance only. Avoids full article evaluation for clearly unrelated items.
const SUMMARY_SYSTEM_INSTRUCTION = `<role>
You are a generous initial screener. Your only job is to filter out articles that are clearly unrelated to the criteria.
</role>

<constraints>
- Ask only: "Could this article plausibly relate to the criteria?"
- Check broad relevance only. Do not judge whether the summary satisfies the criteria.
- Summaries are brief and may omit what the criteria ask for. Do not reject for missing details, evidence, or different emphasis. The full article may contain it.
- Pass the article through if it is likely to be relevant to the criteria. Reject only when it is clearly unrelated.
- When in doubt, answer true.
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
- Interpret the criteria reasonably and holistically. Use common sense to determine if the facts presented satisfy the intent of the criteria.
- Do not demand exact phrasing or overly literal matches. Synthesize the information in the article to evaluate whether it holistically meets the requirements.
- Do not reject an article based on an overly literal or pedantic reading of a single requirement if the core intent of the criteria is met.
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
    trueStatus: EVALUATED_STATUS.matched,
    falseStatus: EVALUATED_STATUS.not_matched
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
Screen this article for potential relevance to the following criteria.

Criteria:
${criteria}
</task>`
}

function buildUserContent(articleText: string, criteria: string): string {
  const raw =
    articleText.length > MAX_PROMPT_LENGTH
      ? `${articleText.slice(0, MAX_PROMPT_LENGTH)}\n\n[Article truncated.]`
      : articleText

  return `<context>
${raw}
</context>

<task>
Determine if the document above satisfies the following criteria.

Criteria:
${criteria}
</task>`
}

// Evaluation Orchestration

function isRetryableApiError(error: unknown): boolean {
  const status = error && typeof error === 'object' && 'status' in error ? (error as { status: number }).status : null

  return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status)
}

async function evaluateWithInstructions<T extends { status: string; reason: string }>(options: {
  model: string
  systemInstruction: string
  userContent: string
  parse: (content: string | undefined) => T
}): Promise<T & { tokens?: number }> {
  const client = getClient()

  let lastError: unknown

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: options.model,
        messages: [
          { role: 'system', content: options.systemInstruction },
          { role: 'user', content: options.userContent }
        ],
        response_format: { type: 'json_object' }
      })

      const result = options.parse(response.choices?.[0]?.message?.content ?? undefined)
      const tokens = response.usage?.total_tokens

      return { ...result, ...(tokens !== undefined && { tokens }) }
    } catch (error) {
      lastError = error

      if (attempt < MAX_RETRIES && isRetryableApiError(error)) {
        await delay(Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS))

        continue
      }

      throw error
    }
  }

  throw lastError
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
