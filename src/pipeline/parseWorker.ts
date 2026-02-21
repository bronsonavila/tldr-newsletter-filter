import { parentPort, workerData } from 'node:worker_threads'
import { Readability } from '@mozilla/readability'
import { JSDOM, VirtualConsole } from 'jsdom'
import type { FetchResult } from './articleFetcher.js'

const { html, url } = workerData as { html: string; url: string }

const virtualConsole = new VirtualConsole()

virtualConsole.on('error', () => {}) // Suppress JSDOM virtual console errors so they don't propagate in the worker.

try {
  const dom = new JSDOM(html, { url, virtualConsole })
  const reader = new Readability(dom.window.document)
  const article = reader.parse()

  if (!article?.textContent?.trim()) {
    parentPort?.postMessage({ ok: false, reason: 'No readable content' } satisfies FetchResult)
  } else {
    parentPort?.postMessage({ ok: true, text: article.textContent.trim() } satisfies FetchResult)
  }
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)

  parentPort?.postMessage({ ok: false, reason } satisfies FetchResult)
}
