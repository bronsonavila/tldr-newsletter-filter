import { MAX_ARTICLE_TEXT_LENGTH } from '../constants.js'
import { EVALUATED_STATUS, type TokenUsage } from '../types.js'
import { evaluateWithInstructions } from './llmClient.js'

// Constants

// Stage 1 screening: Ballpark relevance only. Avoids full article evaluation for clearly unrelated items.
const SUMMARY_SYSTEM_INSTRUCTION = `<role>
You are a generous initial screener. Your only job is to filter out articles that are clearly unrelated to the criteria.
</role>

<constraints>
- Ask only: "Could this article plausibly relate to the criteria?"
- Check broad relevance only. Do not judge whether the summary satisfies the criteria.
- Summaries are brief and may omit what the criteria ask for. Do not reject for missing details, evidence, or different emphasis. The full article may contain it.
- Pass the article through if it is likely to be relevant to the criteria. Reject only when it is clearly unrelated.
- Consider the title and summary together as a whole when judging relevance.
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
- Each criterion must be satisfied on its own terms. Do not treat loosely related content as satisfying a criterion just because there is surface-level overlap.
</constraints>

<output_format>
Return your response as JSON with these exact fields:
{
  "satisfies_criteria": boolean,
  "reason": "Concise explanation (1-4 sentences)"
}
</output_format>`

// Types

export type EvaluateResult =
  | { status: 'matched'; reason: string; tokens?: TokenUsage }
  | { status: 'not_matched'; reason: string; tokens?: TokenUsage }
  | { status: 'evaluation_failed'; reason: string; tokens?: TokenUsage }

export type SummaryEvaluateResult =
  | { status: 'passed'; reason: string; tokens?: TokenUsage }
  | { status: 'rejected'; reason: string; tokens?: TokenUsage }
  | { status: 'evaluation_failed'; reason: string; tokens?: TokenUsage }

export interface EvaluateOptions {
  model: string
  criteria: string[]
}

type BooleanParseResult<T> = { status: T; reason: string } | { status: 'evaluation_failed'; reason: string }

// Helpers

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

function formatCriteria(criteria: string[]): string {
  return criteria.map((criterion, index) => `(${index + 1}) ${criterion}`).join('\n')
}

function buildSummaryUserContent(title: string, summary: string, criteria: string[]): string {
  return `<context>
Title: ${title}

Summary: ${summary}
</context>

<task>
Screen this article for potential relevance to the following criteria.

Criteria:
${formatCriteria(criteria)}
</task>`
}

function buildArticleUserContent(articleText: string, criteria: string[]): string {
  const raw =
    articleText.length > MAX_ARTICLE_TEXT_LENGTH
      ? `${articleText.slice(0, MAX_ARTICLE_TEXT_LENGTH)}\n\n[Article truncated.]`
      : articleText

  return `<context>
${raw}
</context>

<task>
Determine if the document above strictly satisfies all of the following criteria.

Criteria:
${formatCriteria(criteria)}
</task>`
}

// Main Functions

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
  const userContent = buildArticleUserContent(articleText, options.criteria)

  return evaluateWithInstructions({
    model: options.model,
    systemInstruction: ARTICLE_SYSTEM_INSTRUCTION,
    userContent,
    parse: parseStructuredResponse
  })
}
