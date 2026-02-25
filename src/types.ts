// Constants

export const EVALUATED_STATUS = {
  matched: 'matched',
  not_matched: 'not_matched',
  summary_rejected: 'summary_rejected',
  fetch_failed: 'fetch_failed',
  evaluation_failed: 'evaluation_failed'
} as const

// Types

export interface ArticleLink {
  title: string
  url: string
  date: string
  source: string
  summary?: string
}

export type EvaluatedStatus = (typeof EVALUATED_STATUS)[keyof typeof EVALUATED_STATUS]

export interface TokenUsage {
  input: number
  output: number
}

export interface ArticleTokens {
  screening?: TokenUsage
  evaluation?: TokenUsage
}

export interface EvaluatedArticle extends ArticleLink {
  status: EvaluatedStatus
  reason?: string
  analysis?: string
  tokens?: ArticleTokens
}
