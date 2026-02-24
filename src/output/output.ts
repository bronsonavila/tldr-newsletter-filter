import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config.js'
import { OUTPUT_DIR } from '../constants.js'
import type { EvaluatedArticle } from '../types.js'
import { normalizedUrl } from '../utils/url.js'

// Constants

const MATCHING_JSON_FILENAME = 'matching_articles.json'

const MATCHING_MD_FILENAME = 'matching_articles.md'

// Types

export interface MatchingArticlesOutput {
  metadata: {
    newsletters: string[]
    dateStart: string
    dateEnd: string
    criteria: string
    generatedAt: string
    durationMs: number
    models: {
      evaluation: string
      screening?: string
    }
  }
  articles: Array<{
    title: string
    url: string
    date: string
    source: string
    reason?: string
    summary?: string
  }>
}

// Shared Helpers

function dedupeByUrl<T extends { url: string }>(articles: T[]): T[] {
  const seen = new Set<string>()

  return articles.filter(article => {
    const key = normalizedUrl(article.url)

    if (seen.has(key)) return false

    seen.add(key)

    return true
  })
}

function getGeneratedAt(): string {
  return new Date().toISOString()
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)

  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

// Markdown Output

function formatCriteriaForMarkdown(criteria: string): string {
  const lines = criteria.split('\n')

  if (lines.length <= 1) return criteria

  const first = lines[0]
  const rest = lines.slice(1).map(line => `  ${line}`)

  return [first, ...rest].join('\n')
}

function buildMatchingHeader(config: Config, durationMs: number): string {
  const generatedAt = getGeneratedAt()
  const slugList = config.newsletters.join(', ')
  const modelsLine = config.models.screening
    ? `- **Models:** Evaluation: ${config.models.evaluation}; Screening: ${config.models.screening}`
    : `- **Models:** Evaluation: ${config.models.evaluation}`

  return `# Matching Articles

- **Newsletters:** ${slugList}
- **Date range:** ${config.dateStart} to ${config.dateEnd}
- **Criteria:** ${formatCriteriaForMarkdown(config.criteria)}
${modelsLine}
- **Generated:** ${generatedAt}
- **Duration:** ${formatDurationMs(durationMs)}

---

`
}

function buildMatchingMarkdown(articles: EvaluatedArticle[], config: Config, durationMs: number): string {
  const header = buildMatchingHeader(config, durationMs)
  const list = articles
    .map(article => {
      const line = `- ${article.date} – [${article.title}](${normalizedUrl(article.url)}) (${article.source})`
      const reason = article.reason?.trim()

      if (!reason) return line

      const reasonOneLine = reason.replace(/\s+/g, ' ')

      return `${line}\n  - ${reasonOneLine}`
    })
    .join('\n\n')

  return `${header}${list}\n`
}

// JSON Output

function buildMatchingJson(articles: EvaluatedArticle[], config: Config, durationMs: number): MatchingArticlesOutput {
  return {
    metadata: {
      newsletters: config.newsletters,
      dateStart: config.dateStart,
      dateEnd: config.dateEnd,
      criteria: config.criteria,
      generatedAt: getGeneratedAt(),
      durationMs,
      models: {
        evaluation: config.models.evaluation,
        ...(config.models.screening && { screening: config.models.screening })
      }
    },
    articles: articles.map(article => ({
      title: article.title,
      url: normalizedUrl(article.url),
      date: article.date,
      source: article.source,
      ...(article.reason?.trim() && { reason: article.reason.trim() }),
      ...(article.summary?.trim() && { summary: article.summary.trim() })
    }))
  }
}

// Public API

export async function writeOutput(matching: EvaluatedArticle[], config: Config, durationMs: number): Promise<string[]> {
  const matchingDeduped = dedupeByUrl(matching)
  const format = config.outputFormat ?? 'json'
  const outDir = join(process.cwd(), OUTPUT_DIR)

  await mkdir(outDir, { recursive: true })

  const paths: string[] = []

  if (format === 'md' || format === 'both') {
    const mdPath = join(outDir, MATCHING_MD_FILENAME)

    await writeFile(mdPath, buildMatchingMarkdown(matchingDeduped, config, durationMs), 'utf8')

    paths.push(mdPath)
  }

  if (format === 'json' || format === 'both') {
    const jsonPath = join(outDir, MATCHING_JSON_FILENAME)
    const payload = buildMatchingJson(matchingDeduped, config, durationMs)

    await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8')

    paths.push(jsonPath)
  }

  return paths.length > 0 ? paths : [join(outDir, MATCHING_JSON_FILENAME)]
}
