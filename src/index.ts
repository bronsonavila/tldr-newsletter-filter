import 'dotenv/config'
import { EvaluatedStatus } from './types.js'
import { evaluateArticle, evaluateSummary } from './evaluator.js'
import { fetchArticleText } from './articleFetcher.js'
import { initProgressLog, appendProgressLog } from './state.js'
import { loadConfig } from './config.js'
import { normalizedUrl } from './url.js'
import { scrapeArchivesBatched } from './scraper.js'
import { writeOutput } from './output.js'
import ora from 'ora'
import pLimit from 'p-limit'
import type { ArticleLink, EvaluatedArticle } from './types.js'

async function main(): Promise<void> {
  const config = await loadConfig()

  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY

  if (!apiKey) {
    console.error('Set GEMINI_API_KEY or GOOGLE_API_KEY')

    process.exit(1)
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
          spinner.text = `Evaluating... ${counts.done} done, ${counts.matches} ${counts.matches === 1 ? 'match' : 'matches'}`
        }
      }, 400)
    }

    // Process one batch of links at a time. Allow full parallelism so the batch completes before the next scrape batch.
    const limit = pLimit(Math.max(1, linksToProcess.length))

    const pending = linksToProcess.map(link =>
      limit(async () => {
        let tokens = 0

        // Stage 1: Optimized token-saving screen on title and summary only.
        if (link.summary) {
          const summaryResult = await evaluateSummary(link.title, link.summary, {
            model: config.model,
            criteria: config.criteria
          })

          tokens += summaryResult.tokens ?? 0

          if (summaryResult.status === 'rejected') {
            const result: EvaluatedArticle = {
              ...link,
              status: EvaluatedStatus.summary_rejected,
              reason: summaryResult.reason,
              ...(tokens > 0 && { tokens })
            }

            await appendProgressLog(progress, result)

            counts.done += 1

            return
          }
        }

        // Stage 2: Full article fetch and evaluation.
        const fetchResult = await fetchArticleText(link.url)

        if (!fetchResult.ok) {
          const result: EvaluatedArticle = {
            ...link,
            status: EvaluatedStatus.fetch_failed,
            reason: fetchResult.reason,
            ...(tokens > 0 && { tokens })
          }

          await appendProgressLog(progress, result)

          counts.done += 1

          return
        }

        const evaluateResult = await evaluateArticle(fetchResult.text, {
          model: config.model,
          criteria: config.criteria
        })

        tokens += evaluateResult.tokens ?? 0

        const result: EvaluatedArticle = {
          ...link,
          status: evaluateResult.status,
          reason: evaluateResult.reason,
          ...(tokens > 0 && { tokens })
        }

        await appendProgressLog(progress, result)

        counts.done += 1

        if (result.status === EvaluatedStatus.matched) counts.matches += 1
      })
    )

    await Promise.all(pending)
  }

  if (progressInterval) clearInterval(progressInterval)

  if (spinner)
    spinner.succeed(
      `Evaluated ${counts.done} articles, ${counts.matches} ${counts.matches === 1 ? 'match' : 'matches'}`
    )

  // Output is the full set of matched articles from the in-memory progress map (all evaluated this run, keyed by normalized URL).
  const matching = Object.values(progress).filter(record => record.status === EvaluatedStatus.matched)
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
