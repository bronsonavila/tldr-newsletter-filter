import type { Config } from '../config.js'
import type { ArticleLink, EvaluatedArticle } from '../types.js'
import { EVALUATED_STATUS } from '../types.js'
import { fetchArticleText } from './articleFetcher.js'
import { evaluateArticle, evaluateSummary } from './evaluator.js'

export async function evaluateLink(link: ArticleLink, config: Config): Promise<EvaluatedArticle> {
  let tokens = 0

  try {
    // Stage 1: Optional token-saving screen on title and summary only. Skipped when models.screening is not set.
    if (link.summary && config.models.screening) {
      const summaryResult = await evaluateSummary(link.title, link.summary, {
        model: config.models.screening,
        criteria: config.criteria
      })

      tokens += summaryResult.tokens ?? 0

      if (summaryResult.status === 'rejected') {
        return {
          ...link,
          status: EVALUATED_STATUS.summary_rejected,
          reason: summaryResult.reason,
          ...(tokens > 0 && { tokens })
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
        ...(tokens > 0 && { tokens })
      }
    }

    const evaluateResult = await evaluateArticle(fetchResult.text, {
      model: config.models.evaluation,
      criteria: config.criteria
    })

    tokens += evaluateResult.tokens ?? 0

    return {
      ...link,
      status: evaluateResult.status,
      reason: evaluateResult.reason,
      ...(tokens > 0 && { tokens })
    }
  } catch (error) {
    return {
      ...link,
      status: EVALUATED_STATUS.evaluation_failed,
      reason: error instanceof Error ? error.message : String(error),
      ...(tokens > 0 && { tokens })
    }
  }
}
