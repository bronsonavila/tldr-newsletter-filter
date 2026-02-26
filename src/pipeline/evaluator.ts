import { MAX_ARTICLE_TEXT_LENGTH } from '../constants.js'
import { EVALUATED_STATUS, type TokenUsage } from '../types.js'
import { evaluateWithInstructions } from './llmClient.js'
import { ARTICLE_SYSTEM_INSTRUCTION, SUMMARY_SYSTEM_INSTRUCTION } from './prompts.js'

// Types

export type EvaluateResult =
  | { status: 'matched'; reason: string; analysis?: string; tokens?: TokenUsage }
  | { status: 'not_matched'; reason: string; analysis?: string; tokens?: TokenUsage }
  | { status: 'evaluation_failed'; reason: string; analysis?: string; tokens?: TokenUsage }

export type SummaryEvaluateResult =
  | { status: 'passed'; reason: string; tokens?: TokenUsage }
  | { status: 'rejected'; reason: string; tokens?: TokenUsage }
  | { status: 'evaluation_failed'; reason: string; tokens?: TokenUsage }

export interface EvaluateOptions {
  model: string
  criteria: string[]
  url?: string
}

type BooleanParseResult<T> =
  | { status: T; reason: string; analysis?: string }
  | { status: 'evaluation_failed'; reason: string; analysis?: string }

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
    const analysis = typeof parsed.analysis === 'string' ? parsed.analysis : undefined

    if (value === true) {
      return { status: options.trueStatus, reason, ...(analysis && { analysis }) }
    }

    return { status: options.falseStatus, reason, ...(analysis && { analysis }) }
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

function domainFromUrl(url: string | undefined): string {
  if (!url?.trim()) return ''

  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

function buildSummaryUserContent(title: string, summary: string, criteria: string[], url?: string): string {
  const domain = domainFromUrl(url)
  const sourceLine = domain ? `\nSource: ${domain}\n` : '\n'

  return `<context>
Title: ${title}

Summary: ${summary}
${sourceLine}</context>

<task>
Perform a subject-matter check against the following criteria. The title, summary, and source only need to be about the same topic as the criteria; they do not need to satisfy the criteria yet.

Target Criteria:
${formatCriteria(criteria)}
</task>`
}

function buildArticleUserContent(articleText: string, criteria: string[], url?: string): string {
  const raw =
    articleText.length > MAX_ARTICLE_TEXT_LENGTH
      ? `${articleText.slice(0, MAX_ARTICLE_TEXT_LENGTH)}\n\n[Article truncated.]`
      : articleText

  const domain = domainFromUrl(url)
  const sourceLine = domain ? `Source: ${domain}\n\n` : ''

  return `<context>
${sourceLine}${raw}
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
  const userContent = buildSummaryUserContent(title, summary, options.criteria, options.url)

  return evaluateWithInstructions({
    model: options.model,
    systemInstruction: SUMMARY_SYSTEM_INSTRUCTION,
    userContent,
    parse: parseSummaryResponse
  })
}

export async function evaluateArticle(articleText: string, options: EvaluateOptions): Promise<EvaluateResult> {
  const userContent = buildArticleUserContent(articleText, options.criteria, options.url)

  return evaluateWithInstructions({
    model: options.model,
    systemInstruction: ARTICLE_SYSTEM_INSTRUCTION,
    userContent,
    parse: parseStructuredResponse
  })
}
