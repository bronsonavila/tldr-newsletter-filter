export interface ArticleLink {
  title: string
  url: string
  date: string
  source: string
  summary?: string
}

export const EvaluatedStatus = {
  matched: 'matched',
  not_matched: 'not_matched',
  summary_rejected: 'summary_rejected',
  fetch_failed: 'fetch_failed',
  evaluation_failed: 'evaluation_failed'
} as const

export type EvaluatedStatus = (typeof EvaluatedStatus)[keyof typeof EvaluatedStatus]

export interface EvaluatedArticle extends ArticleLink {
  status: EvaluatedStatus
  reason?: string
  tokens?: number
}
