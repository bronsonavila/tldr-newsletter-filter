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
- Focus only on whether the article's topic could relate to the criteria. Never reject because the summary lacks the depth of detail or evidence the criteria describe.
- Pass the article through if it is likely to be relevant to the criteria. Reject only when it is clearly unrelated.
- Consider the title, summary, and source together as a whole when judging relevance.
- When in doubt, answer true.
- Accept all claims in the summary at face value. Never fact-check details against your own knowledge; your training data may be outdated.
</constraints>

<output_format>
Return your response as JSON with these exact fields:
{
  "potentially_relevant": boolean,
  "reason": "Brief explanation (1-2 sentences)"
}
</output_format>`

// Stage 2: Strict article evaluator.
const ARTICLE_SYSTEM_INSTRUCTION = `<role>
You are an analytical article evaluator. Your job is to determine if the provided article satisfies the user's criteria based on the text.
</role>

<constraints>
- Evaluate the document strictly against each criterion. Base your judgment on what the text explicitly states. Do not assume, infer, or stretch definitions to make the document fit.
- Pay absolute attention to any explicit exclusions or negative constraints in the criteria. If a criterion specifies that something should not be included, or does not count, this is a hard boundary that cannot be overridden.
- Each criterion must be evaluated independently. The document must satisfy all criteria to be considered a match. If even one criterion fails, the entire document fails.
- Do not act as a defense attorney for the text. If you have to bend a rule or squint to make the text fit a criterion, it does not fit.
- Accept all factual claims at face value. Never question their veracity based on your own knowledge; your training data may be outdated. Evaluate only whether the text satisfies the criteria as written.
</constraints>

<output_format>
Return your response as JSON with these exact fields:
{
  "analysis": "Briefly evaluate the article against each numbered criterion step-by-step, with explicit note if any negative constraints are violated (1 sentence per criterion).",
  "satisfies_criteria": boolean,
  "reason": "Concise explanation (1-4 sentences) summarizing the final decision."
}
</output_format>`

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
