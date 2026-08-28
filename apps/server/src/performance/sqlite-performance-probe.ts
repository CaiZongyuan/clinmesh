import type {
  SqlitePerformanceObserver,
  SqliteStatementMeasurement,
} from '../infrastructure/sqlite/performance-observer.ts'

export interface SqlitePerformanceSnapshot {
  queryCount: number
  rowsWritten: number
  statementCount: number
  statementDurationsMs: number[]
  transactionDurationsMs: number[]
  writeCount: number
}

export class SqlitePerformanceProbe implements SqlitePerformanceObserver {
  #measurements: SqliteStatementMeasurement[] = []
  #transactionDurationsMs: number[] = []

  observeStatement(measurement: SqliteStatementMeasurement): void {
    this.#measurements.push(measurement)
  }

  observeTransaction(durationMs: number): void {
    this.#transactionDurationsMs.push(durationMs)
  }

  reset(): void {
    this.#measurements = []
    this.#transactionDurationsMs = []
  }

  snapshot(): SqlitePerformanceSnapshot {
    return {
      queryCount: this.#measurements.filter(item => item.kind === 'query').length,
      rowsWritten: this.#measurements.reduce((sum, item) => sum + item.rowsWritten, 0),
      statementCount: this.#measurements.length,
      statementDurationsMs: this.#measurements.map(item => item.durationMs),
      transactionDurationsMs: [...this.#transactionDurationsMs],
      writeCount: this.#measurements.filter(item => item.kind === 'write').length,
    }
  }
}
