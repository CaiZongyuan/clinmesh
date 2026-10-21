import type { DoctorCaseHistoryDetail } from '@clinmesh/contracts/agent'
import { doctorCaseHistoryDetailSchema } from '@clinmesh/contracts/agent'
import { doctorCaseEvidenceSchema } from '@clinmesh/contracts/doctor-recommendations'
import { describe, expect, it } from 'vitest'
import { packDoctorRecommendationHistory } from '../src/application/doctor-recommendation-evidence.ts'

function visible(resourceType: string, index: number,
  clinical: Extract<DoctorCaseHistoryDetail, { source: 'visible-source' }>['clinical'] = { code: { text: '合成临床项目' }, status: 'final' }) {
  return doctorCaseHistoryDetailSchema.parse({
    clinical, clinicalDate: '2006-08-01T09:05:00+08:00', entryId: `source-${index}`,
    missingFieldMeaning: 'not-recorded', resourceType, source: 'visible-source', title: `合成历史项目 ${index}`,
  })
}

function unpack(history: ReturnType<typeof packDoctorRecommendationHistory>): DoctorCaseHistoryDetail[] {
  return [...history.required, ...history.optional].flatMap(evidence => {
    doctorCaseEvidenceSchema.parse(evidence)
    const { entries, ...common } = JSON.parse(evidence.text)
    return entries.map((entry: unknown) => {
      const { fieldPath: _fieldPath, ...detail } = Object(entry)
      return doctorCaseHistoryDetailSchema.parse({
        ...(common.source === 'local-completed' ? { source: common.source } : common), ...detail,
      })
    })
  })
}

describe('doctor recommendation history evidence', () => {
  it('refuses an indivisible field beyond the byte budget while splitting Chinese records between complete fields', () => {
    const chinese = visible('Condition', 0, { conclusion: '并非确诊。'.repeat(700), note: [{ text: '仅既往可疑，尚待复查。'.repeat(350) }],
      clinicalStatus: { text: '已缓解' }, onsetDateTime: '1995-01-01' })
    const fits = packDoctorRecommendationHistory('current-case', [chinese])
    const oversized = packDoctorRecommendationHistory('current-case', [visible('Condition', 1, { conclusion: 'x'.repeat(13 * 1024) })])

    expect(fits.missingInformation).toEqual([])
    expect(fits.required.length).toBeGreaterThan(1)
    for (const evidence of fits.required) {
      expect(evidence.text.length).toBeLessThanOrEqual(12_000)
      expect(Buffer.byteLength(evidence.text)).toBeLessThanOrEqual(12 * 1024)
    }
    expect(new Set(unpack(fits).map(item => item.entryId))).toEqual(new Set(['source-0']))
    expect(Object.assign({}, ...unpack(fits).map(item => item.source === 'visible-source' ? item.clinical : {})))
      .toEqual(chinese.source === 'visible-source' ? chinese.clinical : undefined)
    expect(oversized.required).toEqual([])
    expect(oversized.optional).toEqual([])
    expect(oversized.missingInformation).toEqual(['一条完整历史记录或临床字段超过建议证据预算，无法安全拆分；请核查来源资料。'])
  })

  it('keeps optional records atomic and refuses oversized optional records rather than choosing isolated fragments', () => {
    const result = packDoctorRecommendationHistory('current-case', [visible('DiagnosticReport', 0, {
      conclusion: 'x'.repeat(7000), note: [{ text: 'y'.repeat(7000) }],
    })])

    expect(result.required).toEqual([])
    expect(result.optional).toEqual([])
    expect(result.missingInformation).toHaveLength(1)
  })

  it('uses byte-aware bundles for Chinese text while retaining complete specimens, status and values', () => {
    const history = Array.from({ length: 10 }, (_, index) => {
      const item = visible('Observation', index, { code: { text: '钾' }, valueQuantity: { value: 3.25 + index / 100, unit: 'mmol/L' },
        status: index % 2 === 0 ? 'preliminary' : 'final', note: [{ text: '未见明确异常，仍需结合临床。'.repeat(80) }] })
      return item.source === 'visible-source' ? { ...item, title: index % 2 === 0 ? '血清标本 / 钾' : '全血标本 / 钾' } : item
    })
    const result = packDoctorRecommendationHistory('current-case', history)

    expect(result.missingInformation).toEqual([])
    expect(result.required).toEqual([])
    expect(result.optional.length).toBeGreaterThan(1)
    expect(unpack(result)).toEqual(history)
    for (const evidence of result.optional) expect(Buffer.byteLength(evidence.text)).toBeLessThanOrEqual(16 * 1024)
  })

  it('keeps the full local completed record and uses different evidence identities for different current cases', () => {
    const history = [doctorCaseHistoryDetailSchema.parse({
      source: 'local-completed', entryId: 'completed-case', record: {
        caseId: 'completed-case', completedAt: '2006-08-01T09:05:00+08:00',
        consultation: { version: 1, turns: [{ id: 'old-turn', kind: 'text', messageText: '未服用华法林；此前剂量为每日2.5mg，现已停药。',
          personaRevision: null, recordedAt: '2006-08-01T09:05:00+08:00', reportReference: null,
          sequence: 1, source: 'doctor-typed', speaker: 'doctor' }] },
        clinicalDocuments: [], encounter: { id: 'completed-encounter', status: 'completed', versionId: '1' },
        patient: { id: 'synthetic-patient-a', identifier: 'synthetic-a', name: '合成患者', synthetic: true, versionId: '1' },
        laboratoryRequests: [], timeline: [],
      },
    })]
    const first = packDoctorRecommendationHistory('current-case-a', history)
    const repeated = packDoctorRecommendationHistory('current-case-a', history)
    const other = packDoctorRecommendationHistory('current-case-b', history)

    expect(first.optional).toEqual([])
    expect(unpack(first)).toEqual(history)
    expect(first.required[0]?.id).toBe(repeated.required[0]?.id)
    expect(first.required[0]?.id).not.toBe(other.required[0]?.id)
  })

  it('splits oversized required records only between complete fields and preserves their source identity', () => {
    const history = [visible('Condition', 0, { conclusion: '并非确诊。'.repeat(700),
      note: [{ text: '仅既往可疑，尚待复查。'.repeat(350) }], clinicalStatus: { text: '已缓解' }, onsetDateTime: '1995-01-01' })]
    const result = packDoctorRecommendationHistory('current-case', history)

    expect(result.missingInformation).toEqual([])
    expect(result.optional).toEqual([])
    expect(result.required.length).toBeGreaterThan(1)
    const fragments = result.required.flatMap(evidence => JSON.parse(evidence.text).entries)
    expect(fragments.every(fragment => fragment.entryId === 'source-0' && fragment.clinicalDate === '2006-08-01T09:05:00+08:00'
      && fragment.title === '合成历史项目 0' && typeof fragment.fieldPath === 'string')).toBe(true)
    expect(fragments.reduce((clinical, fragment) => ({ ...clinical, ...fragment.clinical }), {})).toEqual(
      history[0]?.source === 'visible-source' ? history[0].clinical : undefined)
    for (const evidence of result.required) {
      expect(evidence.text.length).toBeLessThanOrEqual(12_000)
      expect(Buffer.byteLength(evidence.text)).toBeLessThanOrEqual(12 * 1024)
    }
  })

  it('keeps old safety facts and abnormal or uncertain observations required without treating unmarked results as normal', () => {
    const history = [
      visible('Condition', 0, { clinicalStatus: { text: '已缓解' }, onsetDateTime: '1995-01-01',
        abatementDateTime: '1996-01-01', note: [{ text: '否认再次发作；既往疑似，尚未证实。' }] }),
      visible('AllergyIntolerance', 1), visible('Device', 2), visible('Procedure', 3),
      visible('MedicationRequest', 4), visible('MedicationAdministration', 5), visible('MedicationStatement', 6),
      visible('Observation', 7, { interpretation: [{ coding: [{ code: 'H', display: 'High' }] }],
        valueQuantity: { comparator: '>', value: 7.25, unit: 'mmol/L' }, status: 'preliminary' }),
      visible('Observation', 8, { interpretation: [{ coding: [{ code: 'L' }] }] }),
      visible('Observation', 9, { interpretation: [{ coding: [{ code: 'A' }] }] }),
      visible('Observation', 10, { interpretation: [{ coding: [{ code: 'unrecognized' }] }] }),
      visible('Observation', 11, { interpretation: [{ coding: [{ code: 'N', display: 'uncertain' }] }] }),
      visible('Observation', 12, { interpretation: [{ text: '无法判断' }] }),
      visible('Observation', 13, { component: [{ interpretation: [{ coding: [{ code: 'H' }] }] }] }),
      visible('Observation', 14, { interpretation: [{ coding: [{ code: 'N', display: 'Normal' }], text: '正常' }] }),
      visible('Observation', 15, { interpretation: [{ text: 'normal' }] }),
      visible('Observation', 16, { status: 'final', valueString: '未标记不代表正常' }),
    ]
    const result = packDoctorRecommendationHistory('current-case', history)

    const required = unpack({ ...result, optional: [] })
    expect(required).toHaveLength(14)
    expect(required.find(item => item.entryId === 'source-0')).toEqual(history[0])
    expect(required.find(item => item.entryId === 'source-7')).toEqual(history[7])
    expect(unpack({ ...result, required: [] }).map(item => item.entryId)).toEqual(['source-14', 'source-15', 'source-16'])
  })

  it('keeps all 596 history resources recoverable while grouping repeated source metadata', () => {
    const counts = { CarePlan: 4, CareTeam: 4, Condition: 39, Device: 8, DiagnosticReport: 25,
      Encounter: 61, ImagingStudy: 3, Immunization: 22, MedicationAdministration: 2,
      MedicationRequest: 10, Observation: 212, Procedure: 176, SupplyDelivery: 30 }
    const history: DoctorCaseHistoryDetail[] = []
    for (const [type, count] of Object.entries(counts)) {
      for (let index = 0; index < count; index += 1) history.push(visible(type, history.length))
    }
    const result = packDoctorRecommendationHistory('current-case', history)

    expect(result.missingInformation).toEqual([])
    const restored = unpack(result).toSorted((a, b) => a.entryId.localeCompare(b.entryId))
    expect(restored).toHaveLength(596)
    for (const [index, item] of history.toSorted((a, b) => a.entryId.localeCompare(b.entryId)).entries()) {
      expect(restored[index]).toEqual(item)
    }
    expect([...result.required, ...result.optional].length).toBeLessThan(100)
    for (const evidence of [...result.required, ...result.optional]) {
      expect(evidence.text.length).toBeLessThanOrEqual(12_000)
      expect(Buffer.byteLength(evidence.text)).toBeLessThanOrEqual(16 * 1024)
    }
  })
})
