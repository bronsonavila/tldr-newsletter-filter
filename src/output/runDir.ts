import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { OUTPUT_DIR } from '../constants.js'

const OUTPUT_DIR_ABSOLUTE = join(process.cwd(), OUTPUT_DIR)

let runDirAbsolute: string | null = null

function generateRunId(): string {
  const now = new Date()

  const pad = (number: number) => String(number).padStart(2, '0')

  const year = now.getFullYear()
  const month = pad(now.getMonth() + 1)
  const day = pad(now.getDate())
  const hours = pad(now.getHours())
  const minutes = pad(now.getMinutes())
  const seconds = pad(now.getSeconds())

  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`
}

export async function initRunDir(): Promise<string> {
  const runId = generateRunId()

  runDirAbsolute = join(OUTPUT_DIR_ABSOLUTE, runId)

  await mkdir(runDirAbsolute, { recursive: true })

  return runDirAbsolute
}

export function getRunDir(): string {
  if (runDirAbsolute === null) {
    throw new Error('Run directory not initialized. Call initRunDir() first.')
  }

  return runDirAbsolute
}
