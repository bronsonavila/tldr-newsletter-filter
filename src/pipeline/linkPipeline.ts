import type { Config } from '../config.js'
import type { ArticleLink, ArticleTokens, EvaluatedArticle } from '../types.js'
import { EVALUATED_STATUS } from '../types.js'
import { fetchArticleText } from './articleFetcher.js'
import { evaluateArticle, evaluateSummary } from './evaluator.js'

export async function evaluateLink(link: ArticleLink, config: Config): Promise<EvaluatedArticle> {
  const tokens: ArticleTokens = {}

  try {
    // Stage 1: Optional token-saving screen on title and summary only. Skipped when models.screening is not set.
    if (link.summary && config.models.screening) {
      const summaryResult = await evaluateSummary(link.title, link.summary, {
        model: config.models.screening,
        criteria: config.criteria,
        url: link.url
      })

      if (summaryResult.tokens) {
        tokens.screening = summaryResult.tokens
      }

      if (summaryResult.status === 'rejected') {
        return {
          ...link,
          status: EVALUATED_STATUS.summary_rejected,
          reason: summaryResult.reason,
          ...(Object.keys(tokens).length > 0 && { tokens })
        }
      }
    }

    // Stage 2: Full article fetch and evaluation.
    const fetchResult = await fetchArticleText(link.url)

    if (!fetchResult.ok) {
      return {
        ...link,
        status: EVALUATED_STATUS.fetch_failed,
        reason: fetchResult.reason,
        ...(Object.keys(tokens).length > 0 && { tokens })
      }
    }

    const evaluateResult = await evaluateArticle(fetchResult.text, {
      model: config.models.evaluation,
      criteria: config.criteria,
      url: link.url
    })

    if (evaluateResult.tokens) {
      tokens.evaluation = evaluateResult.tokens
    }

    return {
      ...link,
      status: evaluateResult.status,
      reason: evaluateResult.reason,
      ...(evaluateResult.analysis && { analysis: evaluateResult.analysis }),
      ...(Object.keys(tokens).length > 0 && { tokens })
    }
  } catch (error) {
    return {
      ...link,
      status: EVALUATED_STATUS.evaluation_failed,
      reason: error instanceof Error ? error.message : String(error),
      ...(Object.keys(tokens).length > 0 && { tokens })
    }
  }
}
