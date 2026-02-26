export function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)

  if (totalSeconds < 60) return `${totalSeconds}s`

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

export function formatThousands(n: number): string {
  return n.toLocaleString('en-US')
}
