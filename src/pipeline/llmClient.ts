import OpenAI, { APIConnectionError, APIConnectionTimeoutError } from 'openai'
import type { TokenUsage } from '../types.js'
import { RETRYABLE_STATUS_CODES, withRetry } from '../utils/retry.js'

let client: OpenAI | null = null

// Helpers

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY

  if (!key) throw new Error('Set OPENROUTER_API_KEY')

  return key
}

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: getApiKey(), baseURL: 'https://openrouter.ai/api/v1' })
  }

  return client
}

function isRetryableApiError(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) return true

  if (error instanceof APIConnectionError) return true

  if (error && typeof error === 'object') {
    if ('code' in error) {
      const code = (error as { code?: string }).code

      if (code === 'ETIMEDOUT' || code === 'ECONNRESET') return true
    }

    if ('status' in error) {
      const status = (error as { status?: number }).status

      if (typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status)) return true
    }
  }

  return false
}

// Main Function

export async function evaluateWithInstructions<T extends { status: string; reason: string }>(options: {
  model: string
  systemInstruction: string
  userContent: string
  parse: (content: string | undefined) => T
}): Promise<T & { tokens?: TokenUsage }> {
  const client = getClient()

  const response = await withRetry(
    () =>
      client.chat.completions.create({
        model: options.model,
        messages: [
          { role: 'system', content: options.systemInstruction },
          { role: 'user', content: options.userContent }
        ],
        response_format: { type: 'json_object' }
      }),
    { isRetryableError: isRetryableApiError }
  )

  const result = options.parse(response.choices?.[0]?.message?.content ?? undefined)
  const usage = response.usage

  const tokens: TokenUsage | undefined =
    usage && (typeof usage.prompt_tokens === 'number' || typeof usage.completion_tokens === 'number')
      ? {
          input: usage.prompt_tokens ?? 0,
          output: usage.completion_tokens ?? 0
        }
      : undefined

  return { ...result, ...(tokens && { tokens }) }
}
