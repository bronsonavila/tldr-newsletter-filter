// Normalize URL (strip utm_source) so the same article under different campaign/source attributions still normalizes to one canonical URL.
export function normalizedUrl(url: string): string {
  try {
    const parsedUrl = new URL(url)

    for (const key of [...parsedUrl.searchParams.keys()]) {
      if (key.toLowerCase() === 'utm_source') parsedUrl.searchParams.delete(key)
    }

    return parsedUrl.toString()
  } catch {
    return url
  }
}
