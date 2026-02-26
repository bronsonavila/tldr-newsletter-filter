import logUpdate from 'log-update'

// Constants

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

const SPINNER_INTERVAL_MS = 80

// Helpers

function isTty(): boolean {
  return Boolean(process.stdout.isTTY)
}

// Main Function

export function createTerminalDisplay() {
  const matchLines: string[] = []

  let spinnerText: string | null = null
  let spinnerFrameIndex = 0
  let spinnerInterval: ReturnType<typeof setInterval> | null = null

  function renderLiveRegion(): void {
    if (!isTty()) return

    const parts: string[] = matchLines.length > 0 ? ['', ...matchLines] : ['']

    if (spinnerText !== null) {
      const frame = SPINNER_FRAMES[spinnerFrameIndex % SPINNER_FRAMES.length]

      if (matchLines.length > 0) parts.push('')

      parts.push(`${frame} ${spinnerText}`)
    }

    const text = parts.join('\n')

    if (text) logUpdate(text)
  }

  return {
    printScrapeProgress(text: string): void {
      if (!isTty()) {
        console.log(text)

        return
      }

      if (spinnerInterval !== null) {
        logUpdate.persist(text)

        renderLiveRegion()
      } else {
        console.log(text)
      }
    },

    printMatch(text: string): void {
      matchLines.push(text)

      if (!isTty()) {
        console.log(text)

        return
      }

      logUpdate.clear()

      renderLiveRegion()
    },

    startSpinner(text: string): void {
      if (!isTty()) return

      spinnerText = text
      spinnerFrameIndex = 0

      renderLiveRegion()

      spinnerInterval = setInterval(() => {
        spinnerFrameIndex += 1

        renderLiveRegion()
      }, SPINNER_INTERVAL_MS)
    },

    updateSpinner(text: string): void {
      if (!isTty()) return

      spinnerText = text
    },

    stop(): void {
      if (spinnerInterval !== null) {
        clearInterval(spinnerInterval)

        spinnerInterval = null
      }

      spinnerText = null

      if (!isTty()) return

      const text = matchLines.length > 0 ? ['', ...matchLines, ''].join('\n') : ''

      if (text) {
        logUpdate(text)
      }

      logUpdate.done()
    }
  }
}

// Types

export type TerminalDisplay = ReturnType<typeof createTerminalDisplay>
