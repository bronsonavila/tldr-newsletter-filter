import 'dotenv/config'
import ora from 'ora'
import { loadConfig } from './config.js'
import { SPINNER_INTERVAL_MS } from './constants.js'
import { writeOutput } from './output/output.js'
import { appendProgressLog, finalizeProgressLog, initProgressLog } from './output/progressLog.js'
import { createBatchProcessor } from './pipeline/batchProcessor.js'
import { evaluateLink } from './pipeline/linkPipeline.js'
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

// Main

async function main(): Promise<void> {
  const config = await loadConfig()

  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error('OPENROUTER_API_KEY must be set')
  }

  // Start fresh each run (no resume); progress is for within-run dedupe and per-result persistence to the log file.
  const progress: Record<string, EvaluatedArticle> = {}

  await initProgressLog(progress, config)

  const startTime = Date.now()
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

  const { limit, queueBatch, flushCompleted, flushAll, waitForCapacity, trackPromise } = createBatchProcessor()

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

    const linkPromises = linksToProcess.map(link => {
      const promise = limit(() => evaluateLink(link, config))

      return trackPromise(promise)
    })

    queueBatch(linkPromises)

    await flushCompleted(result => recordResult(progress, counts, result))

    // Don't pull the next newsletter until the pool has room. Flush after each completion so the log updates.
    await waitForCapacity(async () => await flushCompleted(result => recordResult(progress, counts, result)))
  }

  await flushAll(result => recordResult(progress, counts, result))

  if (progressInterval) clearInterval(progressInterval)

  if (spinner) spinner.stop()

  // Output is the full set of matched articles from the in-memory progress map (all evaluated this run, keyed by normalized URL).
  const matching = Object.values(progress).filter(record => record.status === EVALUATED_STATUS.matched)
  const durationMs = Date.now() - startTime
  const uniqueArticleCount = Object.keys(progress).length

  await finalizeProgressLog(progress, durationMs)

  const outputPaths = await writeOutput(matching, config, durationMs, uniqueArticleCount, matching.length)

  if (matching.length > 0) {
    console.log('\nMatches:')

    for (const article of matching) {
      console.log(`  ${article.title}`)
    }
  }

  const matchLabel = matching.length === 1 ? 'match' : 'matches'

  console.log(
    `\nEvaluated ${uniqueArticleCount} articles, ${matching.length} ${matchLabel} → ${outputPaths.join(', ')}`
  )
}

main().catch(error => {
  console.error(error)

  process.exit(1)
})
