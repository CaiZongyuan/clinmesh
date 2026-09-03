import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  excludedHisRoutes,
  listHisOperations,
} from '@clinmesh/contracts/his-operations'

function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`
}

function registeredHisRoutes(): string[] {
  const source = readFileSync(new URL('../src/app.ts', import.meta.url), 'utf8')
  return [...source.matchAll(/app\.(get|post|put|delete)\(\s*['"]([^'"]+)/g)]
    .map(match => routeKey(match[1]!, match[2]!))
    .filter(route => route.includes(' /api/his/v1/'))
    .toSorted()
}

describe('HIS operation route coverage', () => {
  it('classifies every registered HIS route as canonical or explicitly excluded', () => {
    const operations = listHisOperations().filter(operation => (
      operation.http.path.startsWith('/api/his/v1/')
    ))
    const canonicalRoutes = operations.map(operation => (
      routeKey(operation.http.method, operation.http.path)
    ))
    const excludedRoutes = excludedHisRoutes.map(route => routeKey(route.method, route.path))

    expect(operations).toHaveLength(51)
    expect(excludedHisRoutes).toHaveLength(9)
    expect(new Set(operations.map(operation => operation.id)).size).toBe(operations.length)
    expect(new Set(operations.map(operation => operation.cliPath.join(' '))).size).toBe(operations.length)
    expect(new Set(canonicalRoutes).size).toBe(operations.length)
    expect(operations
      .filter(operation => operation.http.method !== 'GET' && operation.http.encodeBody === undefined)
      .map(operation => operation.id)).toEqual([])
    expect(excludedHisRoutes.every(route => route.reason.length > 0)).toBe(true)
    expect([...canonicalRoutes, ...excludedRoutes].toSorted()).toEqual(registeredHisRoutes())
  })
})
