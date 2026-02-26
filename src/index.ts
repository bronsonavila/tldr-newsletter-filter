import 'dotenv/config'
import { loadConfig } from './config.js'
import { SPINNER_INTERVAL_MS } from './constants.js'
import { printConfigBanner, printResultsSummary } from './output/console.js'
import { writeOutput } from './output/output.js'
import { appendProgressLog, finalizeProgressLog, initProgressLog } from './output/progressLog.js'
import { initRunDir } from './output/runDir.js'
import { createTerminalDisplay, type TerminalDisplay } from './output/terminalDisplay.js'
import { createBatchProcessor } from './pipeline/batchProcessor.js'
import { evaluateLink } from './pipeline/linkPipeline.js'
import { scrapeArchivesBatched } from './pipeline/scraper.js'
import type { ArticleLink, EvaluatedArticle } from './types.js'
import { EVALUATED_STATUS } from './types.js'
import { formatDurationMs } from './utils/format.js'
import { normalizedUrl } from './utils/url.js'

// Helpers

async function recordResult(
  progress: Record<string, EvaluatedArticle>,
  counts: { done: number; matches: number },
  result: EvaluatedArticle,
  display: TerminalDisplay
): Promise<void> {
  await appendProgressLog(progress, result)

  counts.done = Object.keys(progress).length
  counts.matches = Object.values(progress).filter(record => record.status === EVALUATED_STATUS.matched).length

  if (result.status === EVALUATED_STATUS.matched) {
    if (counts.matches === 1) {
      display.printMatch('Matches:')
    }

    display.printMatch(`  ${result.title}`)
  }
}

function matchCountText(count: number): string {
  return count === 1 ? '1 match' : `${count} matches`
}

// Main

async function main(): Promise<void> {
  const config = await loadConfig()

  printConfigBanner(config)

  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    throw new Error('OPENROUTER_API_KEY must be set')
  }

  // Each run writes to its own timestamped directory under output/.
  await initRunDir()

  // Start fresh each run (no resume); progress is for within-run dedupe and per-result persistence to the log file.
  const progress: Record<string, EvaluatedArticle> = {}

  await initProgressLog(progress, config)

  const startTime = Date.now()
  const counts = { done: 0, matches: 0 }
  const queuedUrls = new Set<string>()

  console.log(`Scraping TLDR ${config.newsletters.join(', ')} archives (${config.dateStart} to ${config.dateEnd})...`)

  const display = createTerminalDisplay()

  let progressInterval: ReturnType<typeof setInterval> | null = null

  const shutdown = () => {
    if (progressInterval) clearInterval(progressInterval)

    display.stop()

    console.log('\nInterrupted')

    process.exit(130) // Exit code for SIGINT (Ctrl+C).
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  const { limit, queueBatch, flushCompleted, flushAll, waitForCapacity, trackPromise } = createBatchProcessor(
    config.concurrentLimit
  )

  for await (const batch of scrapeArchivesBatched({
    newsletters: config.newsletters,
    dateStart: config.dateStart,
    dateEnd: config.dateEnd,
    onProgress: (date, source, count) => {
      if (count > 0) display.printScrapeProgress(`${`  ${date} ${source}:`.padEnd(24)}${count} links`)
    }
  })) {
    // Filter out already-processed links. Normalize URL so every record uses the same canonical form.
    const linksToProcess: ArticleLink[] = []

    for (const link of batch.links) {
      const key = normalizedUrl(link.url)

      if (key in progress) continue
      if (queuedUrls.has(key)) continue

      queuedUrls.add(key)

      linksToProcess.push({ ...link, url: key })
    }

    if (linksToProcess.length === 0) continue

    // Start spinner on first batch with links.
    if (progressInterval === null) {
      display.startSpinner('Evaluating...')

      progressInterval = setInterval(() => {
        const elapsed = formatDurationMs(Date.now() - startTime)

        display.updateSpinner(
          `Evaluating... ${counts.done}/${queuedUrls.size} done, ${matchCountText(counts.matches)} (${elapsed})`
        )
      }, SPINNER_INTERVAL_MS)
    }

    const linkPromises = linksToProcess.map(link => {
      const promise = limit(() => evaluateLink(link, config))

      return trackPromise(promise)
    })

    queueBatch(linkPromises)

    await flushCompleted(result => recordResult(progress, counts, result, display))

    // Don't pull the next newsletter until the pool has room. Flush after each completion so the log updates.
    await waitForCapacity(async () => await flushCompleted(result => recordResult(progress, counts, result, display)))
  }

  await flushAll(result => recordResult(progress, counts, result, display))

  if (progressInterval) clearInterval(progressInterval)

  display.stop()

  const matching = Object.values(progress).filter(record => record.status === EVALUATED_STATUS.matched)
  const durationMs = Date.now() - startTime
  const uniqueArticleCount = Object.keys(progress).length

  await finalizeProgressLog(progress, durationMs)

  const outputPaths = await writeOutput(matching, config, durationMs, uniqueArticleCount, matching.length)

  printResultsSummary(progress, durationMs, outputPaths)
}

main().catch(error => {
  console.error(error)

  process.exit(1)
})
