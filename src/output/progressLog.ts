import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Config } from '../config.js'
import type { EvaluatedArticle, EvaluatedStatus } from '../types.js'
import { EVALUATED_STATUS } from '../types.js'
import { normalizedUrl } from '../utils/url.js'
import { getRunDir } from './runDir.js'

// State

// Module-level state for run context (set at init, finalized at end).
let runConfig: Config | null = null
let startedAt: string | null = null
let completedAt: string | null = null
let durationMs: number | null = null
let writeChain: Promise<void> = Promise.resolve()

// Types

export interface ProgressLogMetadata {
  newsletters: string[]
  dateStart: string
  dateEnd: string
  criteria: string
  models: { evaluation: string; screening?: string }
  startedAt: string
  completedAt?: string
  durationMs?: number
  totalArticles: number
  totalTokens: number
  statusCounts: Record<EvaluatedStatus, number>
}

export interface ProgressLogOutput {
  metadata: ProgressLogMetadata
  articles: Record<string, EvaluatedArticle>
}

// Helpers

function defaultStatusCounts(): Record<EvaluatedStatus, number> {
  const counts = {} as Record<EvaluatedStatus, number>

  for (const status of Object.values(EVALUATED_STATUS)) {
    counts[status] = 0
  }

  return counts
}

function computeMetadata(progress: Record<string, EvaluatedArticle>): ProgressLogMetadata | null {
  if (runConfig === null || startedAt === null) return null

  const totalArticles = Object.keys(progress).length

  let totalTokens = 0

  const statusCounts = defaultStatusCounts()

  for (const article of Object.values(progress)) {
    totalTokens += article.tokens ?? 0

    statusCounts[article.status] += 1
  }

  return {
    newsletters: runConfig.newsletters,
    dateStart: runConfig.dateStart,
    dateEnd: runConfig.dateEnd,
    criteria: runConfig.criteria,
    models: {
      evaluation: runConfig.models.evaluation,
      ...(runConfig.models.screening && { screening: runConfig.models.screening })
    },
    startedAt,
    ...(completedAt != null && { completedAt }),
    ...(durationMs != null && { durationMs }),
    totalArticles,
    totalTokens,
    statusCounts
  }
}

async function writeProgressLog(progress: Record<string, EvaluatedArticle>): Promise<void> {
  const logPath = join(getRunDir(), 'log.json')

  const metadata = computeMetadata(progress)

  const payload: ProgressLogOutput = {
    metadata: metadata ?? {
      newsletters: [],
      dateStart: '',
      dateEnd: '',
      criteria: '',
      models: { evaluation: '' },
      startedAt: new Date().toISOString(),
      totalArticles: 0,
      totalTokens: 0,
      statusCounts: defaultStatusCounts()
    },
    articles: progress
  }

  await writeFile(logPath, JSON.stringify(payload, null, 2), 'utf8')
}

// Main Functions

// Do not load from a previous run. Overwrite the log with the initial state (empty object) so each run starts fresh. The log is for post-run inspection and debugging only.
export async function initProgressLog(progress: Record<string, EvaluatedArticle>, config: Config): Promise<void> {
  runConfig = config
  startedAt = new Date().toISOString()
  completedAt = null
  durationMs = null

  await writeProgressLog(progress)
}

export async function appendProgressLog(
  progress: Record<string, EvaluatedArticle>,
  result: EvaluatedArticle
): Promise<void> {
  const key = normalizedUrl(result.url)

  progress[key] = { ...result, url: key }

  const previous = writeChain

  writeChain = previous.then(() => writeProgressLog(progress))

  await writeChain // One write at a time so concurrent appends don't overwrite each other.
}

export async function finalizeProgressLog(
  progress: Record<string, EvaluatedArticle>,
  runDurationMs: number
): Promise<void> {
  completedAt = new Date().toISOString()
  durationMs = runDurationMs

  await writeProgressLog(progress)
}
