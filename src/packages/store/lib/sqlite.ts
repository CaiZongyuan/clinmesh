export type SqlValue = number | string | null;
export type SqlRow = Record<string, SqlValue>;
export type Schedule = <Result>(work: () => Result | Promise<Result>) => Promise<Result>;

export interface SqlConnection {
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): void;
  all(sql: string, ...params: SqlValue[]): SqlRow[];
  initialize(work: () => void): void;
  atomic<T>(work: () => T | Promise<T>): Promise<T>;
  close(): void;
}

export class SerialQueue {
  #tail = Promise.resolve();

  run<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(work);
    this.#tail = result.then(() => {}, () => {});
    return result;
  }
}

export function duringTransaction<Result>(work: (checkOpen: () => void) => Result | Promise<Result>): Result | Promise<Result> {
  let open = true;
  const close = () => { open = false; };
  try {
    const result = work(() => { if (!open) throw new Error('Store transaction is closed'); });
    if (result && typeof (result as PromiseLike<Result>).then === 'function') return Promise.resolve(result).finally(close);
    close();
    return result;
  } catch (error) { close(); throw error; }
}
