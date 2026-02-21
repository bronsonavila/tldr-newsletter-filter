import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

export type OutputFormat = 'md' | 'json' | 'both'

export interface Config {
  newsletters: string[]
  dateStart: string
  dateEnd: string
  criteria: string
  evaluationModel: string
  screeningModel?: string
  outputFormat?: OutputFormat
}

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/

function isValidDate(dateString: string): boolean {
  if (!DATE_REGEX.test(dateString)) return false

  const parsedDate = new Date(dateString)

  return !Number.isNaN(parsedDate.getTime())
}

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

  if (data == null || typeof data !== 'object') {
    throw new Error('Config must be a JSON object')
  }

  const configObject = data as Record<string, unknown>

  const newsletters = configObject.newsletters

  if (!Array.isArray(newsletters) || newsletters.length === 0) {
    throw new Error('Config must have a non-empty array "newsletters"')
  }

  if (!newsletters.every(entry => typeof entry === 'string')) {
    throw new Error('Config "newsletters" must contain only strings')
  }

  const dateStart = configObject.dateStart

  if (typeof dateStart !== 'string' || !isValidDate(dateStart)) {
    throw new Error('Config must have "dateStart" as YYYY-MM-DD')
  }

  const dateEnd = configObject.dateEnd

  if (typeof dateEnd !== 'string' || !isValidDate(dateEnd)) {
    throw new Error('Config must have "dateEnd" as YYYY-MM-DD')
  }

  const criteria = configObject.criteria

  if (typeof criteria !== 'string' || !criteria.trim()) {
    throw new Error('Config must have a non-empty string "criteria"')
  }

  const evaluationModel = configObject.evaluationModel

  if (typeof evaluationModel !== 'string' || !evaluationModel.trim()) {
    throw new Error('Config must have a non-empty string "evaluationModel"')
  }

  const screeningModel = configObject.screeningModel

  if (screeningModel !== undefined && (typeof screeningModel !== 'string' || !screeningModel.trim())) {
    throw new Error('Config "screeningModel" must be a non-empty string if provided')
  }

  const outputFormat = configObject.outputFormat
  const validFormats: OutputFormat[] = ['md', 'json', 'both']
  const resolvedOutputFormat: OutputFormat =
    typeof outputFormat === 'string' && validFormats.includes(outputFormat as OutputFormat)
      ? (outputFormat as OutputFormat)
      : 'json'

  return {
    newsletters: newsletters as string[],
    dateStart: dateStart as string,
    dateEnd: dateEnd as string,
    criteria: (criteria as string).trim(),
    evaluationModel: (evaluationModel as string).trim(),
    ...(screeningModel && { screeningModel: (screeningModel as string).trim() }),
    outputFormat: resolvedOutputFormat
  }
}
