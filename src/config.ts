import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

// Constants

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

// Helpers

function isValidDate(dateString: string): boolean {
  if (!DATE_REGEX.test(dateString)) return false

  const parsedDate = new Date(dateString)

  return !Number.isNaN(parsedDate.getTime())
}

// Schema

const dateString = z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD').refine(isValidDate, 'Must be a valid date')

const outputFormatEnum = z.enum(['md', 'json', 'both'])

export const ConfigSchema = z
  .object({
    newsletters: z.array(z.string()).min(1, "Config must have a non-empty array 'newsletters'"),
    dateRange: z
      .array(dateString)
      .min(1, 'dateRange must have 1 or 2 dates')
      .max(2, 'dateRange must have 1 or 2 dates'),
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
    concurrentLimit: z.number().int().min(1).optional().default(50)
  })
  .refine(data => data.dateRange.length === 1 || new Date(data.dateRange[0]) <= new Date(data.dateRange[1]), {
    message: 'When dateRange has 2 elements, the first must be before or equal to the second',
    path: ['dateRange']
  })
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
