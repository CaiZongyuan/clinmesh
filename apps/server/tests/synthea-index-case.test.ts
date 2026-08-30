import { describe, expect, it } from 'vitest'
import {
  compileSyntheaIndexCase,
  SyntheaIndexCaseError,
  SyntheaIndexCaseReferenceError,
} from '../src/application/scenario-data/synthea-index-case.ts'

function sourceBundle(): {
  entry: Array<{
    fullUrl: string
    resource: { id: string; resourceType: string; [key: string]: unknown }
  }>
  resourceType: 'Bundle'
  type: 'collection'
} {
  return {
    entry: [{
      fullUrl: 'urn:uuid:patient',
      resource: {
        birthDate: '1970-01-01',
        gender: 'female',
        id: 'patient',
        name: [{ text: '张琴' }],
        resourceType: 'Patient',
      },
    }, {
      fullUrl: 'urn:uuid:prior-encounter',
      resource: {
        id: 'prior-encounter',
        period: { end: '2025-01-10T09:30:00+08:00', start: '2025-01-10T09:00:00+08:00' },
        resourceType: 'Encounter',
        status: 'finished',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:prior-condition',
      resource: {
        code: { coding: [{ code: '59621000', display: '高血压（疾病）', system: 'http://snomed.info/sct' }] },
        encounter: { reference: 'urn:uuid:prior-encounter' },
        id: 'prior-condition',
        recordedDate: '2025-01-10T09:05:00+08:00',
        resourceType: 'Condition',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:index-encounter',
      resource: {
        id: 'index-encounter',
        period: { end: '2026-06-01T10:30:00+08:00', start: '2026-06-01T10:00:00+08:00' },
        reasonCode: [{ text: '血压控制不佳' }],
        resourceType: 'Encounter',
        status: 'finished',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:index-condition',
      resource: {
        code: { coding: [{ code: '59621000', display: '高血压（疾病）', system: 'http://snomed.info/sct' }] },
        encounter: { reference: 'urn:uuid:index-encounter' },
        id: 'index-condition',
        recordedDate: '2026-06-01T10:05:00+08:00',
        resourceType: 'Condition',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:index-observation',
      resource: {
        code: { coding: [{ code: '8480-6', display: '收缩压', system: 'http://loinc.org' }] },
        effectiveDateTime: '2026-06-01T10:10:00+08:00',
        encounter: { reference: 'urn:uuid:index-encounter' },
        id: 'index-observation',
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: 'urn:uuid:patient' },
        valueQuantity: { code: 'mm[Hg]', system: 'http://unitsofmeasure.org', unit: 'mmHg', value: 162 },
      },
    }, {
      fullUrl: 'urn:uuid:vaccine-encounter',
      resource: {
        id: 'vaccine-encounter',
        period: { end: '2026-08-01T09:15:00+08:00', start: '2026-08-01T09:00:00+08:00' },
        resourceType: 'Encounter',
        status: 'finished',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:immunization',
      resource: {
        id: 'immunization',
        occurrenceDateTime: '2026-08-01T09:05:00+08:00',
        patient: { reference: 'urn:uuid:patient' },
        resourceType: 'Immunization',
        status: 'completed',
        vaccineCode: { text: '流感疫苗' },
      },
    }],
    resourceType: 'Bundle',
    type: 'collection',
  }
}

describe('Synthea Index Case compiler', () => {
  it('selects the latest clinical Encounter and separates visible history from Case Truth', () => {
    const compiled = compileSyntheaIndexCase(sourceBundle())

    expect(compiled.caseType).toBe('follow-up')
    expect(compiled.indexEncounterReference).toBe('urn:uuid:index-encounter')
    expect(compiled.visibleHistory.map(item => item.sourceReference)).toEqual([
      'urn:uuid:prior-encounter',
      'urn:uuid:prior-condition',
    ])
    expect(compiled.hiddenResourceReferences).toEqual([
      'urn:uuid:index-condition',
      'urn:uuid:index-encounter',
      'urn:uuid:index-observation',
    ])
    expect(compiled.visibleResourceReferences).not.toContain('urn:uuid:vaccine-encounter')
    expect(compiled.visibleResourceReferences).not.toContain('urn:uuid:immunization')
  })

  it('includes clinical resources reached through the Index Encounter reference closure', () => {
    const bundle = sourceBundle()
    bundle.entry.push({
      fullUrl: 'urn:uuid:index-report',
      resource: {
        code: { text: '血常规报告' },
        encounter: { reference: 'urn:uuid:index-encounter' },
        id: 'index-report',
        issued: '2026-06-01T10:20:00+08:00',
        resourceType: 'DiagnosticReport',
        result: [{ reference: 'urn:uuid:report-observation' }],
        status: 'final',
        subject: { reference: 'urn:uuid:patient' },
      },
    }, {
      fullUrl: 'urn:uuid:report-observation',
      resource: {
        code: { coding: [{ code: '6690-2', display: '白细胞计数', system: 'http://loinc.org' }] },
        effectiveDateTime: '2026-06-01T10:15:00+08:00',
        id: 'report-observation',
        resourceType: 'Observation',
        status: 'final',
        subject: { reference: 'urn:uuid:patient' },
        valueQuantity: { code: '10*9/L', system: 'http://unitsofmeasure.org', unit: '10^9/L', value: 8.2 },
      },
    })

    expect(compileSyntheaIndexCase(bundle).hiddenResourceReferences).toEqual(expect.arrayContaining([
      'urn:uuid:index-report',
      'urn:uuid:report-observation',
    ]))
  })

  it('infers new-problem and preventive cases from prior Condition history', () => {
    const newProblem = sourceBundle()
    const priorCondition = newProblem.entry.find(entry => entry.fullUrl === 'urn:uuid:prior-condition')!
    priorCondition.resource.code = {
      coding: [{ code: '44054006', display: '2 型糖尿病', system: 'http://snomed.info/sct' }],
    }
    expect(compileSyntheaIndexCase(newProblem).caseType).toBe('new-problem')

    const preventive = sourceBundle()
    preventive.entry = preventive.entry.filter(entry => entry.fullUrl !== 'urn:uuid:index-condition')
    expect(compileSyntheaIndexCase(preventive).caseType).toBe('preventive')
  })

  it('keeps dated prior Procedures visible and rejects an immunization-only Bundle', () => {
    const bundle = sourceBundle()
    bundle.entry.push({
      fullUrl: 'urn:uuid:prior-procedure',
      resource: {
        code: { text: '动态血压监测' },
        id: 'prior-procedure',
        performedPeriod: {
          end: '2025-03-01T09:30:00+08:00',
          start: '2025-03-01T09:00:00+08:00',
        },
        resourceType: 'Procedure',
        status: 'completed',
        subject: { reference: 'urn:uuid:patient' },
      },
    })
    expect(compileSyntheaIndexCase(bundle).visibleHistory).toEqual(expect.arrayContaining([
      expect.objectContaining({
        clinicalDate: '2025-03-01T09:00:00+08:00',
        sourceReference: 'urn:uuid:prior-procedure',
        title: '动态血压监测',
      }),
    ]))

    const noClinicalEncounter = sourceBundle()
    noClinicalEncounter.entry = noClinicalEncounter.entry.filter(entry => (
      ['urn:uuid:patient', 'urn:uuid:vaccine-encounter', 'urn:uuid:immunization']
        .includes(entry.fullUrl)
    ))
    expect(() => compileSyntheaIndexCase(noClinicalEncounter)).toThrowError(SyntheaIndexCaseError)
  })

  it('rejects unresolved local references before classifying visibility', () => {
    const bundle = sourceBundle()
    const currentObservation = bundle.entry.find(entry => (
      entry.fullUrl === 'urn:uuid:index-observation'
    ))!
    currentObservation.resource.derivedFrom = [{ reference: 'urn:uuid:missing-observation' }]

    expect(() => compileSyntheaIndexCase(bundle)).toThrowError(SyntheaIndexCaseReferenceError)
  })
})
