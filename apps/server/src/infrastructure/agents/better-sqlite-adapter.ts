import type Database from 'better-sqlite3'
import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/chord/sqlite'

const MAX_CACHED_STATEMENTS = 256

/**
 * Adapts a shared synchronous better-sqlite3 connection to chord's async SqliteDatabase
 * contract for pi-durable. Serializes operations and transactions so callers never
 * interleave SQLite transaction state, while leaving connection ownership with ClinMeshDatabase.
 */
export class BetterSqliteAdapter implements SqliteDatabase {
  readonly #driver: Database.Database
  readonly #statements = new Map<string, Database.Statement>()
  #tail: Promise<void> = Promise.resolve()
  #closed = false

  constructor(driver: Database.Database) {
    this.#driver = driver
  }

  async exec(sql: string): Promise<void> {
    return this.#enqueue(() => {
      this.#driver.exec(sql)
    })
  }

  async run(sql: string, ...params: SqliteValue[]): Promise<void> {
    return this.#enqueue(() => {
      this.#prepare(sql).run(...params)
    })
  }

  async runCounted(sql: string, ...params: SqliteValue[]): Promise<number> {
    return this.#enqueue(() => Number(this.#prepare(sql).run(...params).changes))
  }

  async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> {
    return this.#enqueue(() => this.#prepare(sql).get(...params) as T | undefined)
  }

  async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> {
    return this.#enqueue(() => this.#prepare(sql).all(...params) as T[])
  }

  async transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.#enqueue(async () => {
      let active = true
      const assertActive = () => {
        if (!active) throw new Error('SQLite transaction handle is no longer active')
      }
      const txExecutor: SqliteExecutor = {
        exec: async (sql) => {
          assertActive()
          this.#driver.exec(sql)
        },
        run: async (sql, ...params) => {
          assertActive()
          this.#prepare(sql).run(...params)
        },
        runCounted: async (sql, ...params) => {
          assertActive()
          return Number(this.#prepare(sql).run(...params).changes)
        },
        get: async <R extends object>(sql: string, ...params: SqliteValue[]) => {
          assertActive()
          return this.#prepare(sql).get(...params) as R | undefined
        },
        all: async <R extends object>(sql: string, ...params: SqliteValue[]) => {
          assertActive()
          return this.#prepare(sql).all(...params) as R[]
        },
      }
      this.#driver.exec('BEGIN IMMEDIATE')
      try {
        const result = await callback(txExecutor)
        active = false
        this.#driver.exec('COMMIT')
        return result
      } catch (callbackError) {
        active = false
        try {
          if (this.#driver.inTransaction) this.#driver.exec('ROLLBACK')
        } catch (rollbackError) {
          throw new AggregateError([callbackError, rollbackError], 'SQLite transaction rollback failed')
        }
        throw callbackError
      }
    })
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#tail.catch(() => undefined)
    this.#statements.clear()
  }

  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error('BetterSqliteAdapter is closed'))
    }
    const result = this.#tail.then(() => {
      if (this.#closed) throw new Error('BetterSqliteAdapter is closed')
      return work()
    })
    this.#tail = result.then(() => undefined, () => undefined)
    return result
  }

  #prepare(sql: string): Database.Statement {
    let statement = this.#statements.get(sql)
    if (statement === undefined) {
      if (this.#statements.size >= MAX_CACHED_STATEMENTS) {
        const oldest = this.#statements.keys().next().value
        if (oldest !== undefined) this.#statements.delete(oldest)
      }
      statement = this.#driver.prepare(sql)
      this.#statements.set(sql, statement)
    }
    return statement
  }
}
