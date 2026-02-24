import { MAX_BACKOFF_MS, MAX_RETRIES } from '../constants.js'

// Constants

export const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503])

// Types

export interface WithRetryOptions<T> {
  shouldRetry?: (result: T) => boolean
  isRetryableError?: (error: unknown) => boolean
  retries?: number
}

export interface FetchWithRetryOptions {
  retries?: number
  signal?: AbortSignal
  headers?: Record<string, string>
}

// Helpers

function delay(ms: number): Promise<void> {
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

// Main Functions

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: WithRetryOptions<T> = {}
): Promise<T> {
  const { shouldRetry, isRetryableError, retries = MAX_RETRIES } = options

  let lastError: unknown

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await fn()

      if (shouldRetry?.(result) && attempt < retries) {
        const backoffMs = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS)

        await delay(backoffMs)

        continue
      }

      return result
    } catch (error) {
      lastError = error

      if (attempt < retries && isRetryableError?.(error)) {
        const backoffMs = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS)

        await delay(backoffMs)

        continue
      }

      throw error
    }
  }

  throw lastError ?? new Error('Retries exhausted')
}

export async function fetchWithRetry(url: string, options: FetchWithRetryOptions = {}): Promise<Response> {
  const { retries, signal, headers } = options

  return withRetry(() => fetch(url, { headers, signal }), {
    shouldRetry: response => !response.ok && isRetryableResponse(response),
    isRetryableError,
    retries
  })
}
