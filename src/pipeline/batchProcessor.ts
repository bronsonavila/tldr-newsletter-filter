import pLimit from 'p-limit'
import type { EvaluatedArticle } from '../types.js'

// Types

interface PendingLink {
  promise: Promise<EvaluatedArticle>
  result?: EvaluatedArticle
  resolved: boolean
  flushed: boolean
}

interface PendingBatch {
  links: PendingLink[]
}

// Main Function

export function createBatchProcessor(concurrentLimit: number) {
  const limit = pLimit(concurrentLimit)
  const pendingBatches: PendingBatch[] = []
  const inFlightPromises: Set<Promise<EvaluatedArticle>> = new Set()

  return {
    limit,

    // Queue links as a batch so we can flush in newsletter order while writing each result as soon as it completes.
    queueBatch(linkPromises: Promise<EvaluatedArticle>[]): void {
      const pendingLinks: PendingLink[] = linkPromises.map(promise => {
        const link: PendingLink = { promise, resolved: false, flushed: false }

        promise.then(result => {
          link.result = result
          link.resolved = true
        })

        return link
      })

      pendingBatches.push({ links: pendingLinks })
    },

    // Block until the pool has room. Call `onFlush` after each completion so the log updates while awaiting capacity.
    async waitForCapacity(onFlush: () => Promise<void>): Promise<void> {
      while (limit.pendingCount > 0 && inFlightPromises.size > 0) {
        await Promise.race(inFlightPromises)
        await onFlush()
      }
    },

    trackPromise(promise: Promise<EvaluatedArticle>): Promise<EvaluatedArticle> {
      inFlightPromises.add(promise)

      promise.finally(() => inFlightPromises.delete(promise))

      return promise
    },

    // Flush only from the head batch so log order matches newsletter order. Flush each link as it completes.
    async flushCompleted(onResult: (result: EvaluatedArticle) => Promise<void>): Promise<void> {
      while (pendingBatches.length > 0) {
        const batch = pendingBatches[0]

        for (const link of batch.links) {
          if (link.resolved && !link.flushed) {
            const result = link.result

            if (!result) break

            await onResult(result)

            link.flushed = true
          }
        }

        if (batch.links.every(link => link.flushed)) {
          pendingBatches.shift()
        } else {
          break
        }
      }
    },

    async flushAll(onResult: (result: EvaluatedArticle) => Promise<void>): Promise<void> {
      for (const batch of pendingBatches) {
        for (const link of batch.links) {
          if (link.flushed) continue

          const result = await link.promise

          await onResult(result)
        }
      }

      pendingBatches.length = 0
    }
  }
}
