import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

function isValidDate(dateString: string): boolean {
  if (!DATE_REGEX.test(dateString)) return false
  const parsedDate = new Date(dateString)
  return !Number.isNaN(parsedDate.getTime())
}

const dateString = z.string().regex(DATE_REGEX, 'Must be YYYY-MM-DD').refine(isValidDate, 'Must be a valid date')

const outputFormatEnum = z.enum(['md', 'json', 'both'])

export const ConfigSchema = z
  .object({
    newsletters: z.array(z.string()).min(1, "Config must have a non-empty array 'newsletters'"),
    dateStart: dateString,
    dateEnd: dateString,
    criteria: z
      .string()
      .min(1, "Config must have a non-empty string 'criteria'")
      .transform(s => s.trim()),
    evaluationModel: z
      .string()
      .min(1, "Config must have a non-empty string 'evaluationModel'")
      .transform(s => s.trim()),
    screeningModel: z
      .string()
      .min(1)
      .transform(s => s.trim())
      .optional(),
    outputFormat: outputFormatEnum.optional().default('json')
  })
  .refine(data => new Date(data.dateStart) <= new Date(data.dateEnd), {
    message: 'dateStart must be before or equal to dateEnd',
    path: ['dateEnd']
  })

export type Config = z.infer<typeof ConfigSchema>
export type OutputFormat = Config['outputFormat']

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
