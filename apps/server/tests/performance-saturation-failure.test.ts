import { expect, it, vi } from 'vitest'
import { runSaturationPerformanceProfile } from '../src/performance/performance-runner.ts'

const workerState = vi.hoisted(() => ({
  created: 0,
  terminated: 0,
}))

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    Worker: class SyntheticWorker extends EventEmitter {
      readonly #sequence: number

      constructor() {
        super()
        workerState.created += 1
        this.#sequence = workerState.created
        if (this.#sequence === 3) throw new Error('Synthetic Worker spawn failure')
        if (this.#sequence === 1) {
          queueMicrotask(() => {
            this.emit('message', { type: 'ready' })
            queueMicrotask(() => this.emit('message', {
              result: {
                busyCount: 0,
                errorCount: 0,
                latenciesMs: [1],
                retryCount: 0,
                rowsWritten: 20,
                statementCount: 60,
                transactionDurationsMs: [1],
                writeCount: 20,
              },
              type: 'result',
            }))
          })
        }
      }

      terminate(): Promise<number> {
        workerState.terminated += 1
        this.emit('exit', 1)
        return Promise.resolve(1)
      }
    },
  }
})

it('terminates started Workers when a later Worker fails to spawn', async () => {
  await expect(runSaturationPerformanceProfile()).rejects.toThrow(
    'Synthetic Worker spawn failure',
  )
  expect(workerState).toEqual({ created: 3, terminated: 1 })
}, 30_000)
