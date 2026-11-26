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

    expect(operations).toHaveLength(248)
    expect(canonicalRoutes).toEqual(expect.arrayContaining([
      'GET /api/his/v1/identity-quarantine',
      'POST /api/his/v1/identity-quarantine/:candidateId/confirm-merge',
      'GET /api/his/v1/catalogs/concept-vocabulary',
      'GET /api/his/v1/catalogs/disease-packs',
      'GET /api/his/v1/outpatient/cases/:caseId/disease-packs',
      'POST /api/his/v1/outpatient/cases/:caseId/disease-packs/:packId/toggle',
      'GET /api/his/v1/outpatient/cases/:caseId/disease-packs/:packId/tasks/:taskId/readiness',
      'GET /api/his/v1/outpatient/cases/:caseId/disease-packs/:packId/tasks/:taskId/facts',
      'POST /api/his/v1/outpatient/cases/:caseId/disease-packs/:packId/tools/authorize',
      'GET /api/his/v1/outpatient/cases/:caseId/disease-packs/:packId/knowledge',
      'GET /api/his/v1/inpatient/admissions/:admissionId/disease-packs',
      'POST /api/his/v1/inpatient/admissions/:admissionId/disease-packs/:packId/toggle',
      'GET /api/his/v1/inpatient/admissions/:admissionId/disease-packs/:packId/tasks/:taskId/readiness',
      'GET /api/his/v1/inpatient/admissions/:admissionId/disease-packs/:packId/tasks/:taskId/facts',
      'POST /api/his/v1/inpatient/admissions/:admissionId/disease-packs/:packId/tools/authorize',
      'GET /api/his/v1/inpatient/admissions/:admissionId/disease-packs/:packId/knowledge',
      'GET /api/his/v1/encounters/:encounterId/clinical-quality',
      'GET /api/his/v1/inpatient/admissions/:admissionId/clinical-quality',
      'GET /api/his/v1/inpatient/admissions/:admissionId/angiography-reports',
      'POST /api/his/v1/payments/actions/preview-multi-charge',
      'GET /api/his/v1/catalogs/order-set-templates',
      'GET /api/his/v1/doctor/cases/:caseId/order-set-drafts',
      'GET /api/his/v1/inpatient/admissions/:admissionId/order-set-drafts',
      'GET /api/his/v1/inpatient/catalog-search',
      'POST /api/his/v1/payments/:previewId/actions/confirm-multi-charge',
      'POST /api/his/v1/payments/:paymentId/actions/recover-multi-charge',
      'POST /api/his/v1/refunds/actions/preview-allocation',
      'GET /api/his/v1/doctor/cases/:caseId/history',
      'GET /api/his/v1/doctor/cases/:caseId/history/detail',
      'GET /api/his/v1/doctor/cases/:caseId/examination-services',
      'POST /api/his/v1/examination-requests/:requestId/reports/:diagnosticReportId/actions/acknowledge',
      'GET /api/his/v1/inpatient/pci-data',
      'POST /api/his/v1/inpatient/pci-data/prepare',
      'POST /api/his/v1/inpatient/admissions/:admissionId/surgeries/record-medication',
      'POST /api/his/v1/inpatient/admissions/:admissionId/surgeries/preview-completion',
      'POST /api/his/v1/inpatient/admissions/:admissionId/surgeries/supplement-material',
      'POST /api/his/v1/inpatient/admissions/:admissionId/surgeries/convert-to-pci',
      'POST /api/his/v1/inpatient/admissions/:admissionId/surgeries/finalize-standby',
      'POST /api/his/v1/inpatient/admissions/:admissionId/pci-selection/save',
      'GET /api/his/v1/inpatient/admissions/:admissionId/guideline-advice',
      'POST /api/his/v1/inpatient/admissions/:admissionId/guideline-advice/request',
    ]))
    expect(excludedHisRoutes).toHaveLength(26)
    expect(excludedRoutes).toEqual(expect.arrayContaining([
      'GET /api/his/v1/doctor/cases/:caseId/recommendations/:kind/confirmations/:idempotencyKey',
      'POST /api/his/v1/doctor/cases/:caseId/recommendations/:kind/actions/confirm',
      'GET /api/his/v1/inpatient/admissions/:admissionId/guideline-advice/:requestId',
      'GET /api/his/v1/inpatient/admissions/:admissionId/surgeries/request-reason',
      'POST /api/his/v1/inpatient/admissions/:admissionId/surgeries/request-reason',
      'POST /api/his/v1/offline/knowledge-claims/draft-pipeline',
      'POST /api/his/v1/offline/guidelines/diff-report',
      'POST /api/his/v1/offline/guidelines/adjudicate-conflict',
      'POST /api/his/v1/offline/concept-mappings/impact-report',
      'POST /api/his/v1/offline/guidelines/search',
      'POST /api/his/v1/evaluation/agent-output-score',
    ]))
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
