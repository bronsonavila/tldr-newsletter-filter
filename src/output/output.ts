import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config.js'
import type { EvaluatedArticle } from '../types.js'
import { normalizedUrl } from '../utils/url.js'
import { getRunDir } from './runDir.js'

// Constants

const MATCHING_JSON_FILENAME = 'matching_articles.json'

const MATCHING_MD_FILENAME = 'matching_articles.md'

// Types

export interface MatchingArticlesOutput {
  metadata: {
    newsletters: string[]
    dateStart: string
    dateEnd: string
    criteria: string[]
    generatedAt: string
    durationMs: number
    evaluatedCount: number
    matchCount: number
    models: {
      screening?: string
      evaluation: string
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

// Helpers

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

function formatCriteriaForMarkdown(criteria: string[]): string {
  if (criteria.length === 0) return ''

  return `\n${criteria.map((criterion, index) => `  ${index + 1}. ${criterion}`).join('\n')}`
}

function buildMatchingHeader(
  config: Config,
  durationMs: number,
  evaluatedCount: number,
  matchCount: number
): string {
  const generatedAt = getGeneratedAt()
  const slugList = config.newsletters.join(', ')
  const modelsLine = config.models.screening
    ? `- **Models:** Screening: ${config.models.screening}; Evaluation: ${config.models.evaluation}`
    : `- **Models:** Evaluation: ${config.models.evaluation}`

  return `# Matching Articles

- **Newsletters:** ${slugList}
- **Date range:** ${config.dateStart} to ${config.dateEnd}
- **Criteria:** ${formatCriteriaForMarkdown(config.criteria)}
${modelsLine}
- **Evaluated:** ${evaluatedCount} articles, ${matchCount} ${matchCount === 1 ? 'match' : 'matches'}
- **Generated:** ${generatedAt}
- **Duration:** ${formatDurationMs(durationMs)}

---

`
}

function buildMatchingMarkdown(
  articles: EvaluatedArticle[],
  config: Config,
  durationMs: number,
  evaluatedCount: number,
  matchCount: number
): string {
  const header = buildMatchingHeader(config, durationMs, evaluatedCount, matchCount)
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

function buildMatchingJson(
  articles: EvaluatedArticle[],
  config: Config,
  durationMs: number,
  evaluatedCount: number,
  matchCount: number
): MatchingArticlesOutput {
  return {
    metadata: {
      newsletters: config.newsletters,
      dateStart: config.dateStart,
      dateEnd: config.dateEnd,
      criteria: config.criteria,
      generatedAt: getGeneratedAt(),
      durationMs,
      evaluatedCount,
      matchCount,
      models: {
        ...(config.models.screening && { screening: config.models.screening }),
        evaluation: config.models.evaluation
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

// Main Function

export async function writeOutput(
  matching: EvaluatedArticle[],
  config: Config,
  durationMs: number,
  evaluatedCount: number,
  matchCount: number
): Promise<string[]> {
  const matchingDeduped = dedupeByUrl(matching)
  const format = config.outputFormat ?? 'json'
  const runDir = getRunDir()

  const paths: string[] = []

  if (format === 'md' || format === 'both') {
    const mdPath = join(runDir, MATCHING_MD_FILENAME)

    await writeFile(
      mdPath,
      buildMatchingMarkdown(matchingDeduped, config, durationMs, evaluatedCount, matchCount),
      'utf8'
    )

    paths.push(mdPath)
  }

  if (format === 'json' || format === 'both') {
    const jsonPath = join(runDir, MATCHING_JSON_FILENAME)
    const payload = buildMatchingJson(
      matchingDeduped,
      config,
      durationMs,
      evaluatedCount,
      matchCount
    )

    await writeFile(jsonPath, JSON.stringify(payload, null, 2), 'utf8')

    paths.push(jsonPath)
  }

  return paths.length > 0 ? paths : [join(runDir, MATCHING_JSON_FILENAME)]
}
