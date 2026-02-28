import type { z } from 'zod'
import { MAX_ARTICLE_TEXT_LENGTH } from '../constants.js'
import { EVALUATED_STATUS, type TokenUsage } from '../types.js'
import { evaluateWithInstructions } from './llmClient.js'
import {
  ARTICLE_RESPONSE_SCHEMA,
  ARTICLE_SYSTEM_INSTRUCTION,
  SUMMARY_RESPONSE_SCHEMA,
  SUMMARY_SYSTEM_INSTRUCTION
} from './prompts.js'

// Types

export type SummaryEvaluateResult =
  | { status: 'passed'; reason: string; tokens?: TokenUsage }
  | { status: 'rejected'; reason: string; tokens?: TokenUsage }
  | { status: 'evaluation_failed'; reason: string; tokens?: TokenUsage }

export type ArticleEvaluateResult =
  | { status: 'matched'; reason: string; analysis?: string; tokens?: TokenUsage }
  | { status: 'not_matched'; reason: string; analysis?: string; tokens?: TokenUsage }
  | { status: 'evaluation_failed'; reason: string; analysis?: string; tokens?: TokenUsage }

export interface EvaluateOptions {
  model: string
  criteria: string[]
  url?: string
}

type SummaryResponse = z.infer<typeof SUMMARY_RESPONSE_SCHEMA>

type ArticleResponse = z.infer<typeof ARTICLE_RESPONSE_SCHEMA>

// Helpers

function parseStructuredResponse(parsed: ArticleResponse | null): ArticleEvaluateResult {
  if (!parsed) {
    return { status: 'evaluation_failed', reason: 'Empty or refused response' }
  }

  const { analysis, satisfies_criteria: satisfiesCriteria, reason } = parsed

  if (satisfiesCriteria) {
    return { status: EVALUATED_STATUS.matched, reason, ...(analysis && { analysis }) }
  }

  return { status: EVALUATED_STATUS.not_matched, reason, ...(analysis && { analysis }) }
}

function parseSummaryResponse(parsed: SummaryResponse | null): SummaryEvaluateResult {
  if (!parsed) {
    return { status: 'evaluation_failed', reason: 'Empty or refused response' }
  }

  const { potentially_relevant: potentiallyRelevant, reason } = parsed

  if (potentiallyRelevant) {
    return { status: 'passed', reason }
  }

  return { status: 'rejected', reason }
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
    responseSchema: SUMMARY_RESPONSE_SCHEMA,
    schemaName: 'screening_response',
    parse: parseSummaryResponse
  })
}

export async function evaluateArticle(articleText: string, options: EvaluateOptions): Promise<ArticleEvaluateResult> {
  const userContent = buildArticleUserContent(articleText, options.criteria, options.url)

  return evaluateWithInstructions({
    model: options.model,
    systemInstruction: ARTICLE_SYSTEM_INSTRUCTION,
    userContent,
    responseSchema: ARTICLE_RESPONSE_SCHEMA,
    schemaName: 'evaluation_response',
    parse: parseStructuredResponse
  })
}
