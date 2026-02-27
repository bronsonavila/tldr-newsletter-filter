import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

// Constants

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

// Helpers

function formatLocalDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${year}-${month}-${day}`
}

function isoToday(): string {
  return formatLocalDate(new Date())
}

function isoRelative(daysOffset: number, baseDate?: string): string {
  const date = baseDate ? new Date(`${baseDate}T00:00:00`) : new Date()

  date.setDate(date.getDate() + daysOffset)

  return formatLocalDate(date)
}

function resolveDate(value: string, baseDate?: string): string {
  const lower = value.trim().toLowerCase()

  if (lower === 'today') return isoToday()
  if (lower === 'yesterday') return isoRelative(-1, baseDate)

  const relativeDayMatch = lower.match(/^-(\d+)d$/)

  if (relativeDayMatch) return isoRelative(-Number(relativeDayMatch[1]), baseDate)

  return value
}

function isValidDate(dateString: string): boolean {
  if (!DATE_REGEX.test(dateString)) return false

  const parsedDate = new Date(dateString)

  return !Number.isNaN(parsedDate.getTime())
}

function resolveDateRange(range: string[]): string[] {
  if (range.length === 1) {
    const resolved = resolveDate(range[0])

    if (!DATE_REGEX.test(resolved) || !isValidDate(resolved)) throw new Error('Invalid date format')

    return [resolved]
  }

  const endDate = resolveDate(range[1])

  if (!DATE_REGEX.test(endDate) || !isValidDate(endDate)) throw new Error('Invalid date format')

  const startDate = resolveDate(range[0], endDate)

  if (!DATE_REGEX.test(startDate) || !isValidDate(startDate)) throw new Error('Invalid date format')

  return [startDate, endDate]
}

// Schema

const outputFormatEnum = z.enum(['md', 'json', 'both'])

export const ConfigSchema = z
  .object({
    newsletters: z.array(z.string()).min(1, "Config must have a non-empty array 'newsletters'"),
    dateRange: z
      .array(z.string())
      .min(1, 'dateRange must have 1 or 2 dates')
      .max(2, 'dateRange must have 1 or 2 dates')
      .transform(resolveDateRange),
    criteria: z
      .array(z.string().transform(s => s.trim()))
      .transform(arr => arr.filter(s => s.length > 0))
      .refine(arr => arr.length > 0, "Config must have a non-empty array 'criteria'"),
    models: z.object({
      screening: z
        .string()
        .transform(s => s.trim() || undefined)
        .optional(),
      evaluation: z
        .string()
        .min(1, "Config must have a non-empty string 'models.evaluation'")
        .transform(s => s.trim())
    }),
    outputFormat: outputFormatEnum.optional().default('json'),
    concurrentLimit: z.number().int().min(1).optional().default(15)
  })
  .refine(
    data => {
      if (data.dateRange.length === 1) return true

      return new Date(data.dateRange[0]) <= new Date(data.dateRange[1])
    },
    {
      message: 'When dateRange has 2 elements, the first must be before or equal to the second',
      path: ['dateRange']
    }
  )
  .transform(data => ({
    ...data,
    dateStart: data.dateRange[0],
    dateEnd: data.dateRange[data.dateRange.length - 1]
  }))

// Types

export type Config = z.infer<typeof ConfigSchema>

export type OutputFormat = Config['outputFormat']

// Main Function

export async function loadConfig(): Promise<Config> {
  const path = join(process.cwd(), 'config.json')

  let raw: string

  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    throw new Error(`Config file not found or unreadable (${path}): ${message}`)
  }

  let data: unknown

  try {
    data = JSON.parse(raw)
  } catch {
    throw new Error(`Invalid JSON in config file: ${path}`)
  }

  const result = ConfigSchema.safeParse(data)

  if (!result.success) {
    const first = result.error.flatten().formErrors[0] ?? result.error.message

    throw new Error(`Invalid config: ${first}`)
  }

  return result.data
}
