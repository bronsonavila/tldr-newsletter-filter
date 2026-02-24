import OpenAI from 'openai'
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
  const status = error && typeof error === 'object' && 'status' in error ? (error as { status: number }).status : null

  return typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status)
}

// Main Function

export async function evaluateWithInstructions<T extends { status: string; reason: string }>(options: {
  model: string
  systemInstruction: string
  userContent: string
  parse: (content: string | undefined) => T
}): Promise<T & { tokens?: number }> {
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
  const tokens = response.usage?.total_tokens

  return { ...result, ...(tokens !== undefined && { tokens }) }
}
