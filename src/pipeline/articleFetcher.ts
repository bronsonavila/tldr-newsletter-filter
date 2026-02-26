import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { FETCH_TIMEOUT_MS, PARSE_TIMEOUT_MS, USER_AGENT } from '../constants.js'
import { fetchWithRetry } from '../utils/retry.js'

// Constants

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://tldr.tech/'
}

const WORKER_PATH = fileURLToPath(new URL('./parseWorker.ts', import.meta.url))

// Types

export type FetchResult = { ok: true; text: string } | { ok: false; reason: string }

// Helpers

function failureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.message.includes('timeout')) return 'Timeout'

    return error.message.length > 200 ? `${error.message.slice(0, 200)}…` : error.message
  }

  return String(error)
}

// JSDOM + Readability are synchronous and CPU-heavy. Running in a worker keeps the main thread responsive.
function parseInWorker(html: string, url: string): Promise<FetchResult> {
  return new Promise(resolve => {
    const worker = new Worker(WORKER_PATH, {
      workerData: { html, url },
      execArgv: ['--import', 'tsx']
    })

    // Guard against the worker hanging or exiting without a message.
    let settled = false

    function settle(result: FetchResult): void {
      if (settled) return

      settled = true

      worker.terminate()

      resolve(result)
    }

    const timer = setTimeout(() => settle({ ok: false, reason: 'Parse timeout' }), PARSE_TIMEOUT_MS)

    worker.once('message', (result: FetchResult) => {
      clearTimeout(timer)

      settle(result)
    })

    worker.once('error', error => {
      clearTimeout(timer)

      settle({ ok: false, reason: failureReason(error) })
    })

    worker.once('exit', code => {
      clearTimeout(timer)

      settle({ ok: false, reason: `Worker exited unexpectedly (code ${code})` })
    })
  })
}

// Main Function

export async function fetchArticleText(url: string): Promise<FetchResult> {
  try {
    const response = await fetchWithRetry(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` }
    }

    const html = await response.text()
    const result = await parseInWorker(html, url)

    if (!result.ok) return result

    return { ok: true, text: result.text }
  } catch (error) {
    return { ok: false, reason: failureReason(error) }
  }
}
