import { MAX_BACKOFF_MS, MAX_RETRIES } from '../constants.js'

export const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503])

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRetryableResponse(response: Response): boolean {
  return RETRYABLE_STATUS_CODES.has(response.status)
}

function isRetryableError(error: unknown): boolean {
  if (error instanceof TypeError && (error.message === 'Failed to fetch' || error.message.includes('network'))) {
    return true
  }

  return false
}

export interface FetchWithRetryOptions {
  retries?: number
  signal?: AbortSignal
  headers?: Record<string, string>
}

// Fetch with exponential backoff. Retries on 429, 5xx, and network errors.
export async function fetchWithRetry(url: string, options: FetchWithRetryOptions = {}): Promise<Response> {
  const { retries = MAX_RETRIES, signal, headers } = options

  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, { headers, signal })

      if (response.ok) return response

      if (attempt < retries && isRetryableResponse(response)) {
        const backoffMs = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS)

        await delay(backoffMs)

        continue
      }

      return response
    } catch (error) {
      lastError = error

      if (attempt < retries && isRetryableError(error)) {
        const backoffMs = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS)

        await delay(backoffMs)

        continue
      }

      throw error
    }
  }

  throw lastError
}
