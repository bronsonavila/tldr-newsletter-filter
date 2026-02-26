import * as cheerio from 'cheerio'
import { SCRAPE_TIMEOUT_MS, USER_AGENT } from '../constants.js'
import type { ArticleLink } from '../types.js'
import { fetchWithRetry } from '../utils/retry.js'
import { normalizedUrl } from '../utils/url.js'

// Constants

const SPONSOR_MARKER = '(Sponsor)'

const TLDR_BASE = 'https://tldr.tech'

// Types

export interface ScrapeOptions {
  newsletters: string[]
  dateStart: string
  dateEnd: string
  onProgress?: (date: string, source: string, count: number) => void
}

export interface ArchiveBatch {
  date: string
  source: string
  links: ArticleLink[]
}

// Helpers

function dateRange(start: string, end: string): string[] {
  const startDate = new Date(start)
  const endDate = new Date(end)

  if (startDate > endDate) {
    throw new Error(`Invalid date range: start (${start}) is after end (${end})`)
  }

  const dates: string[] = []
  const current = new Date(startDate)

  while (current <= endDate) {
    dates.push(current.toISOString().slice(0, 10))

    current.setUTCDate(current.getUTCDate() + 1) // Use UTC date math to avoid DST issues.
  }

  return dates
}

function dateSourcePairs(
  newsletters: string[],
  startDate: string,
  endDate: string
): { date: string; source: string }[] {
  const pairs: { date: string; source: string }[] = []

  for (const date of dateRange(startDate, endDate)) {
    for (const source of newsletters) {
      pairs.push({ date, source })
    }
  }

  return pairs
}

function normalizeTitle(title: string): string {
  return title.replace(/\s*\(\d+\s*minute\s*read\)\s*$/i, '').trim()
}

async function fetchArchivePage(url: string): Promise<string | null> {
  try {
    const response = await fetchWithRetry(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS)
    })

    if (!response.ok) return null

    return await response.text()
  } catch {
    return null
  }
}

// Tied to TLDR archive HTML: Link wraps an h3. Summary exists in the following sibling with class .newsletter-html.
function extractLinksFromHtml(html: string, date: string, source: string): ArticleLink[] {
  const $ = cheerio.load(html)
  const links: ArticleLink[] = []

  $('a').each((_, element) => {
    const $a = $(element)
    const $h3 = $a.children('h3').first()

    if ($h3.length !== 1) return

    const href = $a.attr('href')

    if (!href?.startsWith('http')) return

    const title = normalizeTitle($a.text())

    if (!title || title.includes(SPONSOR_MARKER)) return

    const summary = $a.next('.newsletter-html').text().trim() || undefined

    links.push({ title, url: href, date, source, ...(summary && { summary }) })
  })

  return links
}

// Main Function

export async function* scrapeArchivesBatched(options: ScrapeOptions): AsyncGenerator<ArchiveBatch> {
  const { newsletters, dateStart, dateEnd } = options
  const seen = new Set<string>() // Same link can appear on multiple archive pages; skip duplicates.

  for (const { date, source } of dateSourcePairs(newsletters, dateStart, dateEnd)) {
    const url = `${TLDR_BASE}/${source}/${date}`
    const html = await fetchArchivePage(url)

    if (!html) continue

    const allLinks = extractLinksFromHtml(html, date, source)
    const newLinks: ArticleLink[] = []

    for (const link of allLinks) {
      const key = normalizedUrl(link.url)

      if (seen.has(key)) continue

      seen.add(key)

      newLinks.push(link)
    }

    options.onProgress?.(date, source, newLinks.length)

    if (newLinks.length > 0) {
      yield { date, source, links: newLinks }
    }
  }
}
