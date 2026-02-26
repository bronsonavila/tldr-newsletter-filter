import { relative } from 'node:path'
import type { Config } from '../config.js'
import type { ArticleTokens, EvaluatedArticle, TokenUsage } from '../types.js'
import { EVALUATED_STATUS } from '../types.js'
import { formatDurationMs, formatThousands } from '../utils/format.js'

// Constants

const DEFAULT_COLUMNS = 80

const SUMMARY_LABEL_WIDTH = 13

// Helpers

function dayCount(dateStart: string, dateEnd: string): number {
  const start = new Date(dateStart).getTime()
  const end = new Date(dateEnd).getTime()

  return Math.floor((end - start) / (24 * 60 * 60 * 1000)) + 1
}

function modelShortName(modelId: string): string {
  const segments = modelId.split('/')

  return segments.length > 1 ? (segments[segments.length - 1] ?? modelId) : modelId
}

function truncateCriterion(text: string, maxLength: number): string {
  const trimmed = text.trim()

  const ellipsis = '...'

  if (maxLength <= 0 || trimmed.length <= maxLength) return trimmed

  if (maxLength <= ellipsis.length) return ellipsis

  return `${trimmed.slice(0, maxLength - ellipsis.length)}${ellipsis}`
}

function padLabel(label: string): string {
  return label.padEnd(SUMMARY_LABEL_WIDTH)
}

function computeResultsSummary(progress: Record<string, EvaluatedArticle>): {
  statusCounts: Record<string, number>
  totalTokens: Partial<Record<keyof ArticleTokens, TokenUsage>>
} {
  const statusCounts: Record<string, number> = {}

  for (const status of Object.values(EVALUATED_STATUS)) {
    statusCounts[status] = 0
  }

  const totalTokens: Partial<Record<keyof ArticleTokens, TokenUsage>> = {}

  for (const article of Object.values(progress)) {
    statusCounts[article.status] += 1

    const tokens = article.tokens

    if (tokens) {
      for (const key of ['screening', 'evaluation'] as const) {
        const usage = tokens[key]

        if (usage) {
          const existing = totalTokens[key] ?? { input: 0, output: 0 }

          totalTokens[key] = {
            input: existing.input + usage.input,
            output: existing.output + usage.output
          }
        }
      }
    }
  }

  return { statusCounts, totalTokens }
}

// Main Functions

export function printConfigBanner(config: Config): void {
  const days = dayCount(config.dateStart, config.dateEnd)
  const dateRangeLine = `${config.dateStart} to ${config.dateEnd} (${days} ${days === 1 ? 'day' : 'days'})`
  const screeningShort = config.models.screening ? modelShortName(config.models.screening) : null
  const evaluationShort = modelShortName(config.models.evaluation)
  const modelsLine =
    screeningShort != null
      ? `screening: ${screeningShort}, evaluation: ${evaluationShort}`
      : `evaluation: ${evaluationShort}`

  console.log('')
  console.log(`Newsletters: ${config.newsletters.join(', ')}`)
  console.log(`Date range:  ${dateRangeLine}`)
  console.log('Criteria:')

  const columns = process.stdout.columns ?? DEFAULT_COLUMNS

  for (let index = 0; index < config.criteria.length; index++) {
    const prefix = `  ${index + 1}. `
    const maxCriterionLength = Math.max(0, columns - prefix.length)

    console.log(`${prefix}${truncateCriterion(config.criteria[index], maxCriterionLength)}`)
  }

  console.log(`Models:      ${modelsLine}`)
  console.log(`Concurrency: ${config.concurrentLimit}`)
  console.log('')
}

export function printResultsSummary(
  progress: Record<string, EvaluatedArticle>,
  durationMs: number,
  outputPaths: string[]
): void {
  const { statusCounts, totalTokens } = computeResultsSummary(progress)
  const evaluatedCount = Object.keys(progress).length
  const duration = formatDurationMs(durationMs)
  const cwd = process.cwd()

  console.log('Results:')
  console.log(`  ${padLabel('Evaluated:')}${formatThousands(evaluatedCount)} articles in ${duration}`)
  console.log(`  ${padLabel('Matched:')}${formatThousands(statusCounts[EVALUATED_STATUS.matched])}`)
  console.log(`  ${padLabel('Not matched:')}${formatThousands(statusCounts[EVALUATED_STATUS.not_matched])}`)
  console.log(
    `  ${padLabel('Rejected:')}${formatThousands(statusCounts[EVALUATED_STATUS.summary_rejected])} (screening)`
  )

  const fetchFailed = statusCounts[EVALUATED_STATUS.fetch_failed]
  const evaluationFailed = statusCounts[EVALUATED_STATUS.evaluation_failed]
  const failedParts: string[] = []

  if (fetchFailed > 0) failedParts.push(`${formatThousands(fetchFailed)} (fetch)`)
  if (evaluationFailed > 0) failedParts.push(`${formatThousands(evaluationFailed)} (evaluation)`)

  if (failedParts.length > 0) {
    console.log(`  ${padLabel('Failed:')}${failedParts.join(', ')}`)
  }

  const screeningUsage = totalTokens.screening
  const evaluationUsage = totalTokens.evaluation

  if (screeningUsage) {
    console.log(
      `  ${padLabel('Tokens:')}${formatThousands(screeningUsage.input)} input / ${formatThousands(screeningUsage.output)} output (screening)`
    )
  }

  if (evaluationUsage) {
    const tokensLabel = screeningUsage ? ' '.repeat(SUMMARY_LABEL_WIDTH) : padLabel('Tokens:')

    console.log(
      `  ${tokensLabel}${formatThousands(evaluationUsage.input)} input / ${formatThousands(evaluationUsage.output)} output (evaluation)`
    )
  }

  if (outputPaths.length > 0) {
    const relativePath = relative(cwd, outputPaths[0])

    console.log(`  ${padLabel('Output:')}${relativePath}`)

    for (let index = 1; index < outputPaths.length; index++) {
      console.log(`  ${' '.repeat(SUMMARY_LABEL_WIDTH)}${relative(cwd, outputPaths[index])}`)
    }
  }
}
