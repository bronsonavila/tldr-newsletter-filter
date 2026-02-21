import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

const MAX_ARTICLE_LENGTH = 120_000

const WORKER_PATH = fileURLToPath(new URL('./parseWorker.ts', import.meta.url))

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://tldr.tech/'
}

export type FetchResult = { ok: true; text: string } | { ok: false; reason: string }

function failureReason(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.message.includes('timeout')) return 'Timeout'

    return error.message.length > 200 ? error.message.slice(0, 200) + '…' : error.message
  }

  return String(error)
}

// JSDOM + Readability are synchronous and CPU-heavy. Running in a worker keeps the main thread responsive.
function parseInWorker(html: string, url: string): Promise<FetchResult> {
  return new Promise(resolve => {
    const worker = new Worker(WORKER_PATH, { workerData: { html, url }, execArgv: ['--import', 'tsx'] })

    worker.once('message', (result: FetchResult) => resolve(result))
    worker.once('error', error => resolve({ ok: false, reason: failureReason(error) }))
  })
}

export async function fetchArticleText(url: string): Promise<FetchResult> {
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(20_000) })

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}` }
    }

    const html = await response.text()
    const result = await parseInWorker(html, url)

    if (!result.ok) return result

    // 120k cap after Readability. The classifier further truncates to 100k for the prompt.
    const final = result.text.length > MAX_ARTICLE_LENGTH ? result.text.slice(0, MAX_ARTICLE_LENGTH) : result.text

    return { ok: true, text: final }
  } catch (error) {
    return { ok: false, reason: failureReason(error) }
  }
}
