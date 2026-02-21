import 'dotenv/config'
import ora from 'ora'
import pLimit from 'p-limit'
import type { Config } from './config.js'
import { loadConfig } from './config.js'
import { SPINNER_INTERVAL_MS } from './constants.js'
import { writeOutput } from './output/output.js'
import { appendProgressLog, initProgressLog } from './output/progressLog.js'
import { fetchArticleText } from './pipeline/articleFetcher.js'
import { evaluateArticle, evaluateSummary } from './pipeline/evaluator.js'
import { scrapeArchivesBatched } from './pipeline/scraper.js'
import type { ArticleLink, EvaluatedArticle } from './types.js'
import { EVALUATED_STATUS } from './types.js'
import { normalizedUrl } from './utils/url.js'

// Helpers

async function recordResult(
  progress: Record<string, EvaluatedArticle>,
  counts: { done: number; matches: number },
  result: EvaluatedArticle
): Promise<void> {
  await appendProgressLog(progress, result)

  counts.done += 1

  if (result.status === EVALUATED_STATUS.matched) counts.matches += 1
}

function matchCountText(count: number): string {
  return count === 1 ? '1 match' : `${count} matches`
}

// Link Processor

async function processLink(
  link: ArticleLink,
  config: Config,
  progress: Record<string, EvaluatedArticle>,
  counts: { done: number; matches: number }
): Promise<void> {
  let tokens = 0

  // Stage 1: Optional token-saving screen on title and summary only. Skipped when screeningModel is not set.
  if (link.summary && config.screeningModel) {
    const summaryResult = await evaluateSummary(link.title, link.summary, {
      model: config.screeningModel,
      criteria: config.criteria
    })

    tokens += summaryResult.tokens ?? 0

    if (summaryResult.status === 'rejected') {
      await recordResult(progress, counts, {
        ...link,
        status: EVALUATED_STATUS.summary_rejected,
        reason: summaryResult.reason,
        ...(tokens > 0 && { tokens })
      })

      return
    }
  }

  // Stage 2: Full article fetch and evaluation.
  const fetchResult = await fetchArticleText(link.url)

  if (!fetchResult.ok) {
    await recordResult(progress, counts, {
      ...link,
      status: EVALUATED_STATUS.fetch_failed,
      reason: fetchResult.reason,
      ...(tokens > 0 && { tokens })
    })

    return
  }

  const evaluateResult = await evaluateArticle(fetchResult.text, {
    model: config.evaluationModel,
    criteria: config.criteria
  })

  tokens += evaluateResult.tokens ?? 0

  await recordResult(progress, counts, {
    ...link,
    status: evaluateResult.status,
    reason: evaluateResult.reason,
    ...(tokens > 0 && { tokens })
  })
}

// Main

async function main(): Promise<void> {
  const config = await loadConfig()

  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error('OPENROUTER_API_KEY must be set')
  }

  // Start fresh each run (no resume); progress is for within-run dedupe and per-result persistence to the log file.
  const progress: Record<string, EvaluatedArticle> = {}

  await initProgressLog(progress)

  const counts = { done: 0, matches: 0 }

  console.log(`Scraping TLDR ${config.newsletters.join(', ')} archives (${config.dateStart} to ${config.dateEnd})...`)

  let spinner: ReturnType<typeof ora> | null = null
  let progressInterval: ReturnType<typeof setInterval> | null = null

  const shutdown = () => {
    if (progressInterval) clearInterval(progressInterval)
    if (spinner) spinner.stop()

    console.log('\nInterrupted')

    process.exit(130) // Exit code for SIGINT (Ctrl+C).
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  for await (const batch of scrapeArchivesBatched({
    newsletters: config.newsletters,
    dateStart: config.dateStart,
    dateEnd: config.dateEnd,
    onProgress: (date, source, count) => {
      if (count > 0) console.log(`  ${date} ${source}: ${count} links`)
    }
  })) {
    // Filter out already-processed links. Normalize URL so every record uses the same canonical form.
    const linksToProcess: ArticleLink[] = []

    for (const link of batch.links) {
      const key = normalizedUrl(link.url)

      if (key in progress) continue

      linksToProcess.push({ ...link, url: key })
    }

    if (linksToProcess.length === 0) continue

    // Start spinner on first batch with links.
    if (!spinner) {
      spinner = ora({ text: 'Evaluating...', stream: process.stdout, discardStdin: false }).start()

      progressInterval = setInterval(() => {
        if (spinner) {
          spinner.text = `Evaluating... ${counts.done} done, ${matchCountText(counts.matches)}`
        }
      }, SPINNER_INTERVAL_MS)
    }

    // Process one batch of links at a time. Allow full parallelism so the batch completes before the next scrape batch.
    const limit = pLimit(Math.max(1, linksToProcess.length))
    const pending = linksToProcess.map(link => limit(() => processLink(link, config, progress, counts)))

    await Promise.all(pending)
  }

  if (progressInterval) clearInterval(progressInterval)

  if (spinner) spinner.succeed(`Evaluated ${counts.done} articles, ${matchCountText(counts.matches)}`)

  // Output is the full set of matched articles from the in-memory progress map (all evaluated this run, keyed by normalized URL).
  const matching = Object.values(progress).filter(record => record.status === EVALUATED_STATUS.matched)
  const outputPaths = await writeOutput(matching, config)

  if (matching.length > 0) {
    console.log('\nMatches:')

    for (const article of matching) {
      console.log(`  ${article.title}`)
    }
  }

  console.log(`\n${matching.length} matching → ${outputPaths.join(', ')}`)
}

main().catch(error => {
  console.error(error)

  process.exit(1)
})
