import { createHash } from 'node:crypto'

function rawChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

export function migrationChecksum(sql: string): string {
  return rawChecksum(sql.replaceAll('\r\n', '\n'))
}

export function matchesMigrationChecksum(sql: string, expected: string): boolean {
  const normalized = sql.replaceAll('\r\n', '\n')
  // Existing databases contain raw LF or CRLF hashes. Keep their receipts intact.
  return [sql, normalized, normalized.replaceAll('\n', '\r\n')]
    .some(candidate => rawChecksum(candidate) === expected)
}
