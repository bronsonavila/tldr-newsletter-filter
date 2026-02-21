import { EvaluatedStatus } from './types.js'
import { GoogleGenAI } from '@google/genai'

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
You are an initial screener for articles. Your job is to decide whether an article's core topic is in the right ballpark for the criteria, using only the title and summary.
</role>

<constraints>
- The summary is brief and will not contain every detail the criteria ask for. That is expected.
- Focus on the core topic of the article. Does it broadly fall within the subject area the criteria describe?
- Do not require the summary to mention specific details. Those details may exist in the full article even if the summary omits them.
- Do reject articles whose core topic is clearly in a different domain when the criteria are about something else.
</constraints>`

// Stage 2: Strictly grounded article evaluator.
const ARTICLE_SYSTEM_INSTRUCTION = `<role>
You are a strictly grounded article evaluator. You are precise and analytical.
</role>

<constraints>
- You are a strictly grounded assistant limited to the information provided in the User Context.
- In your answers, rely only on the facts that are directly mentioned in that context. You must not access or utilize your own knowledge or common sense to answer.
- Do not assume or infer from the provided facts; simply report them exactly as they appear.
- Treat the provided context as the absolute limit of truth; any facts or details that are not directly mentioned in the context must be considered completely untruthful and completely unsupported.
</constraints>`

export interface EvaluateOptions {
  model: string
  criteria: string
}

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY

  if (!key) throw new Error('Set GEMINI_API_KEY or GOOGLE_API_KEY')

  return key
}

let client: GoogleGenAI | null = null

function getClient(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: getApiKey() })

  return client
}

// Stage 1 summary screening response schema.
const SUMMARY_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    potentially_relevant: {
      type: 'boolean',
      description:
        "Whether the article's core topic is in the right ballpark for the criteria. Lenient on missing details, strict on wrong topic."
    },
    reason: { type: 'string', description: 'Brief explanation (1-2 sentences).', maxLength: 300 }
  },
  required: ['potentially_relevant', 'reason']
} as const

// Stage 2 structured evaluation response schema.
const ARTICLE_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    satisfies_criteria: { type: 'boolean', description: 'Whether the article satisfies the criteria.' },
    reason: {
      type: 'string',
      description:
        'Concise explanation of why the article does or does not satisfy the criteria (1-4 sentences; keep it tight, with at most 4 for matches).',
      maxLength: 500
    }
  },
  required: ['satisfies_criteria', 'reason']
} as const

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
1. Ask: "Is this article's core topic in the right ballpark for the criteria?" If yes, answer true.
2. Do not reject an article just because the summary lacks specific detials. Summaries are brief — the full article may contain those details.
3. Do reject articles whose topic is clearly in a different domain from what the criteria describe.

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

  const response = await client.models.generateContent({
    model: options.model,
    contents: userContent,
    config: {
      systemInstruction: SUMMARY_SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseJsonSchema: SUMMARY_RESPONSE_SCHEMA
    }
  })

  const result = parseSummaryResponse(response.text)
  const tokens = response.usageMetadata?.totalTokenCount

  return { ...result, ...(tokens !== undefined && { tokens }) }
}

function buildUserContent(articleText: string, criteria: string): string {
  // Cap prompt size for the model. The article fetcher may provide more, but truncate here for the evaluation request.
  const raw = articleText.length > 100_000 ? articleText.slice(0, 100_000) + '\n\n[Article truncated.]' : articleText

  return `<context>
${raw}
</context>

<task>
Based on the entire document above, determine if it satisfies the following criteria:

${criteria}
</task>`
}

export async function evaluateArticle(articleText: string, options: EvaluateOptions): Promise<EvaluateResult> {
  const client = getClient()
  const userContent = buildUserContent(articleText, options.criteria)

  const response = await client.models.generateContent({
    model: options.model,
    contents: userContent,
    config: {
      systemInstruction: ARTICLE_SYSTEM_INSTRUCTION,
      responseMimeType: 'application/json',
      responseJsonSchema: ARTICLE_RESPONSE_SCHEMA
    }
  })

  const result = parseStructuredResponse(response.text)
  const tokens = response.usageMetadata?.totalTokenCount

  return { ...result, ...(tokens !== undefined && { tokens }) }
}
