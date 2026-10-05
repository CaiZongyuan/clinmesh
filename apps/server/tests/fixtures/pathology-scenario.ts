import { commandResponseSchema } from '@clinmesh/contracts/his'
import { pathologyPreparationBatchSchema } from '@clinmesh/contracts/pathology'
import { expect } from 'vitest'
import { mutation, snomed, type Runtime } from './imaging-scenario.ts'

const loinc = 'http://loinc.org'
export const receptorPositive = '10828004'
export const receptorNegative = '260385009'
export const lumpectomy = { code: '392021009', display: '乳房肿块切除术' }
export const breastLesionExcision = { code: '392023007', display: '乳腺病灶切除术' }

export interface BreastCase {
  birthDate?: string
  /** 缺省 ER 阳性；null 表示来源没有该 Observation。 */
  er?: string | null
  gender?: 'female' | 'male'
  her2?: string | null
  /** 缺省 cN1。 */
  n?: string | null
  name: string
  pr?: string | null
  /** 缺省一次早于本次就诊的肿块切除；`indexVisit` 的手术记在本次就诊中。 */
  procedures?: Array<{ code: string; display: string; indexVisit?: boolean }>
  /** 缺省 cT2。 */
  t?: string | null
  withoutBreastCancer?: boolean
}

/**
 * 合成 Synthea R4 乳腺随访病例：2022 年的既往就诊承载乳腺恶性肿瘤诊断、受体与 TNM Observation 和乳腺手术，
 * 最后一次就诊（2026 年）是 Index Encounter。Observation 形态与 Synthea 的 R4 导出一致。
 */
export function breastCaseBundle(input: BreastCase) {
  const observation = (id: string, code: string, display: string, valueCode: string) => ({
    fullUrl: `urn:uuid:${id}`,
    resource: {
      category: [{ coding: [{ code: 'laboratory', system: 'http://terminology.hl7.org/CodeSystem/observation-category' }] }],
      code: { coding: [{ code, display, system: loinc }], text: display },
      effectiveDateTime: '2022-03-01T09:10:00+08:00',
      encounter: { reference: 'urn:uuid:prior-encounter' },
      id,
      issued: '2022-03-01T09:10:00.000+08:00',
      resourceType: 'Observation',
      status: 'final',
      subject: { reference: 'urn:uuid:patient' },
      valueCodeableConcept: { coding: [{ code: valueCode, display: `SNOMED ${valueCode}`, system: snomed }] },
    },
  })
  const fact = (id: string, code: string, display: string, value: string | null | undefined, fallback: string) => (
    value === null ? [] : [observation(id, code, display, value ?? fallback)]
  )
  const procedure = (item: { code: string; display: string; indexVisit?: boolean }, index: number) => {
    const start = item.indexVisit === true ? '2026-06-01T10:05:00+08:00' : `2022-04-0${index + 1}T08:00:00+08:00`
    return {
      fullUrl: `urn:uuid:procedure-${index}`,
      resource: {
        code: { coding: [{ code: item.code, display: item.display, system: snomed }] },
        encounter: { reference: `urn:uuid:${item.indexVisit === true ? 'index' : 'prior'}-encounter` },
        id: `procedure-${index}`,
        performedPeriod: { end: start, start },
        resourceType: 'Procedure',
        status: 'completed',
        subject: { reference: 'urn:uuid:patient' },
      },
    }
  }
  return {
    entry: [
      {
        fullUrl: 'urn:uuid:patient',
        resource: {
          birthDate: input.birthDate ?? '1968-01-01',
          gender: input.gender ?? 'female',
          id: 'patient',
          name: [{ text: input.name }],
          resourceType: 'Patient',
        },
      },
      {
        fullUrl: 'urn:uuid:prior-encounter',
        resource: {
          id: 'prior-encounter',
          period: { end: '2022-03-01T09:30:00+08:00', start: '2022-03-01T09:00:00+08:00' },
          resourceType: 'Encounter',
          status: 'finished',
          subject: { reference: 'urn:uuid:patient' },
        },
      },
      ...(input.withoutBreastCancer === true
        ? []
        : [{
            fullUrl: 'urn:uuid:breast-cancer',
            resource: {
              code: { coding: [{ code: '254837009', display: '乳腺恶性肿瘤', system: snomed }] },
              encounter: { reference: 'urn:uuid:prior-encounter' },
              id: 'breast-cancer',
              recordedDate: '2022-03-01T09:05:00+08:00',
              resourceType: 'Condition',
              subject: { reference: 'urn:uuid:patient' },
            },
          }]),
      ...fact('er', '85337-4', '雌激素受体', input.er, receptorPositive),
      ...fact('pr', '85339-0', '孕激素受体', input.pr, receptorPositive),
      ...fact('her2', '85319-2', 'HER2 免疫组化', input.her2, receptorNegative),
      ...fact('n', '21906-3', '区域淋巴结临床分期', input.n, '1229973008'),
      ...fact('t', '21905-5', '原发肿瘤临床分期', input.t, '1228929004'),
      ...(input.procedures ?? [lumpectomy]).map(procedure),
      {
        fullUrl: 'urn:uuid:index-encounter',
        resource: {
          id: 'index-encounter',
          period: { end: '2026-06-01T10:30:00+08:00', start: '2026-06-01T10:00:00+08:00' },
          reasonCode: [{ text: '乳腺癌术后随访' }],
          resourceType: 'Encounter',
          status: 'finished',
          subject: { reference: 'urn:uuid:patient' },
        },
      },
    ],
    resourceType: 'Bundle',
    type: 'collection',
  }
}

export async function preparePathology(runtime: Runtime, cookie: string, caseIds?: string[]) {
  const response = await runtime.app.request('/api/sim/v1/admin/pathology-preparations', mutation(cookie, {
    input: caseIds === undefined ? {} : { caseIds },
  }))
  expect(response.status).toBe(200)
  return commandResponseSchema(pathologyPreparationBatchSchema).parse(await response.json()).data
}
