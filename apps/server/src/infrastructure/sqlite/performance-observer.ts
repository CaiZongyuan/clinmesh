import type Database from 'better-sqlite3'

export type SqliteStatementKind = 'query' | 'transaction' | 'write'

export interface SqliteStatementMeasurement {
  durationMs: number
  kind: SqliteStatementKind
  rowsWritten: number
  sql: string
}

export interface SqlitePerformanceObserver {
  observeStatement: (measurement: SqliteStatementMeasurement) => void
  observeTransaction: (durationMs: number) => void
}

function statementKind(sql: string, execution: 'all' | 'exec' | 'get' | 'iterate' | 'pragma' | 'run'):
SqliteStatementKind {
  const normalized = sql.trim().toUpperCase()
  if (/^(?:BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/u.test(normalized)) return 'transaction'
  if (execution !== 'run' && execution !== 'exec') return 'query'
  if (/^(?:SELECT|EXPLAIN|WITH)\b/u.test(normalized)) return 'query'
  return 'write'
}

function instrumentStatement(
  statement: Database.Statement<unknown[], unknown>,
  observer: SqlitePerformanceObserver,
): Database.Statement<unknown[], unknown> {
  return new Proxy(statement, {
    get(target, property) {
      if (property === 'run') {
        return (...parameters: unknown[]) => {
          const startedAt = performance.now()
          const result = target.run(...parameters)
          observer.observeStatement({
            durationMs: performance.now() - startedAt,
            kind: statementKind(target.source, 'run'),
            rowsWritten: result.changes,
            sql: target.source,
          })
          return result
        }
      }
      if (property === 'get' || property === 'all' || property === 'iterate') {
        return (...parameters: unknown[]) => {
          const startedAt = performance.now()
          const result = target[property](...parameters)
          observer.observeStatement({
            durationMs: performance.now() - startedAt,
            kind: statementKind(target.source, property),
            rowsWritten: 0,
            sql: target.source,
          })
          return result
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export function instrumentSqliteDriver(
  driver: Database.Database,
  observer: SqlitePerformanceObserver,
): Database.Database {
  let transactionStartedAt: number | undefined
  return new Proxy(driver, {
    get(target, property) {
      if (property === 'prepare') {
        return (source: string) => instrumentStatement(
          target.prepare(source) as Database.Statement<unknown[], unknown>,
          observer,
        )
      }
      if (property === 'exec') {
        return (source: string) => {
          const startedAt = performance.now()
          const normalized = source.trim().toUpperCase()
          const result = target.exec(source)
          const finishedAt = performance.now()
          observer.observeStatement({
            durationMs: finishedAt - startedAt,
            kind: statementKind(source, 'exec'),
            rowsWritten: 0,
            sql: source,
          })
          if (/^BEGIN\b/u.test(normalized)) transactionStartedAt = startedAt
          if (/^(?:COMMIT|ROLLBACK)\b/u.test(normalized) && transactionStartedAt !== undefined) {
            observer.observeTransaction(finishedAt - transactionStartedAt)
            transactionStartedAt = undefined
          }
          return result
        }
      }
      if (property === 'pragma') {
        return (source: string, options?: Database.PragmaOptions) => {
          const startedAt = performance.now()
          const result = target.pragma(source, options)
          observer.observeStatement({
            durationMs: performance.now() - startedAt,
            kind: statementKind(source, 'pragma'),
            rowsWritten: 0,
            sql: `PRAGMA ${source}`,
          })
          return result
        }
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as Database.Database
}
