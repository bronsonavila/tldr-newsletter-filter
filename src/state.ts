import { join } from 'node:path'
import { normalizedUrl } from './url.js'
import { writeFile, mkdir } from 'node:fs/promises'
import type { EvaluatedArticle } from './types.js'

const OUTPUT_DIR = join(process.cwd(), 'output')

const LOG_PATH = join(OUTPUT_DIR, 'log.json')

async function ensureOutputDir(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true })
}

async function writeProgressLog(progress: Record<string, EvaluatedArticle>): Promise<void> {
  await ensureOutputDir()
  await writeFile(LOG_PATH, JSON.stringify(progress, null, 2), 'utf8')
}

let writeChain: Promise<void> = Promise.resolve()

// Do not load from a previous run. Overwrite the log with the initial state (empty object) so each run starts fresh. The log is for post-run inspection and debugging only.
export async function initProgressLog(progress: Record<string, EvaluatedArticle>): Promise<void> {
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
