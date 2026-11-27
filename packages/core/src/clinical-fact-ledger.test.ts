import { describe, expect, it } from 'vitest'
import { clinicalFactLedgerSchema } from '@clinmesh/contracts/clinical-fact-ledger'
import {
  evaluateClinicalFactLedger,
  getPublicValidityDays,
  tightenValidityDays,
  transcribeBedsideQuestionnaireFacts,
  transcribeLocalFhirFacts,
  transcribeVisibleSourceHistoryFacts,
} from './clinical-fact-ledger.ts'

describe('clinical-fact-ledger core transcription and evaluation', () => {
  it('transcribes all 8 categories, extracts Observation.component vitals, excludes drafts and narrative docs', () => {
    const localCandidates = transcribeLocalFhirFacts({
      observations: [
        {
          id: 'obs-triage-1',
          status: 'final',
          category: [{ coding: [{ code: 'vital-signs' }] }],
          code: { coding: [{ code: '85353-1', system: 'http://loinc.org', display: '生命体征' }] },
          effectiveDateTime: '2026-08-24T08:15:00+08:00',
          issued: '2026-08-24T08:16:00+08:00',
          component: [
            {
              code: { coding: [{ code: '8480-6', system: 'http://loinc.org', display: '收缩压' }] },
              valueQuantity: { value: 132, unit: 'mmHg' },
            },
            {
              code: { coding: [{ code: '8867-4', system: 'http://loinc.org', display: '心率' }] },
              valueQuantity: { value: 76, unit: '/min' },
            },
          ],
          meta: { versionId: '1', lastUpdated: '2026-08-24T08:16:00+08:00' },
        },
        {
          id: 'obs-draft-skip',
          status: 'preliminary',
          code: { coding: [{ code: '2160-0', system: 'http://loinc.org', display: '肌酐' }] },
          valueQuantity: { value: 1.0, unit: 'mg/dL' },
          meta: { versionId: '1', lastUpdated: '2026-08-24T08:20:00+08:00' },
        },
      ],
      diagnosticReports: [
        {
          id: 'rep-ecg-1',
          status: 'final',
          category: [{ coding: [{ code: 'ECG' }] }],
          code: { coding: [{ code: '11524-6', system: 'http://loinc.org', display: '十二导联心电图' }] },
          effectiveDateTime: '2026-08-24T08:30:00+08:00',
          issued: '2026-08-24T08:35:00+08:00',
          conclusion: '窦性心律，ST段V2-V4轻度压低',
          meta: { versionId: '1', lastUpdated: '2026-08-24T08:35:00+08:00' },
        },
      ],
      conditions: [
        {
          id: 'cond-1',
          verificationStatus: { coding: [{ code: 'confirmed' }] },
          code: { coding: [{ code: 'I21.4', system: 'http://hl7.org/fhir/sid/icd-10', display: '急性非ST段抬高型心肌梗死' }] },
          recordedDate: '2026-08-24T08:40:00+08:00',
          meta: { versionId: '1', lastUpdated: '2026-08-24T08:40:00+08:00' },
        },
        {
          id: 'cond-prov',
          verificationStatus: { coding: [{ code: 'provisional' }] },
          code: { coding: [{ code: 'E11.9', system: 'http://hl7.org/fhir/sid/icd-10', display: '2型糖尿病（待排）' }] },
          recordedDate: '2026-08-24T08:42:00+08:00',
          meta: { versionId: '1', lastUpdated: '2026-08-24T08:42:00+08:00' },
        },
      ],
      allergyIntolerances: [
        {
          id: 'allergy-1',
          verificationStatus: { coding: [{ code: 'confirmed' }] },
          code: { coding: [{ code: 'allergy-penicillin', display: '青霉素' }] },
          recordedDate: '2026-08-24T08:10:00+08:00',
          reaction: [{ manifestation: [{ text: '皮疹' }] }],
          meta: { versionId: '1', lastUpdated: '2026-08-24T08:10:00+08:00' },
        },
      ],
      medications: [
        {
          resourceType: 'MedicationRequest',
          id: 'med-draft',
          status: 'draft',
          medicationCodeableConcept: { coding: [{ code: 'aspirin', display: '阿司匹林' }] },
          authoredOn: '2026-08-24T08:45:00+08:00',
        },
        {
          resourceType: 'MedicationRequest',
          id: 'med-active',
          status: 'active',
          medicationCodeableConcept: { coding: [{ code: 'aspirin', display: '阿司匹林肠溶片' }] },
          authoredOn: '2026-08-24T08:50:00+08:00',
          dosageInstruction: [{ text: '100 mg PO QD' }],
          meta: { versionId: '1', lastUpdated: '2026-08-24T08:50:00+08:00' },
        },
      ],
      procedures: [
        {
          id: 'proc-1',
          status: 'completed',
          code: { coding: [{ code: 'pci-stent', display: '经皮冠状动脉介入术' }] },
          performedDateTime: '2026-08-24T09:10:00+08:00',
          meta: { versionId: '1', lastUpdated: '2026-08-24T09:15:00+08:00' },
        },
      ],
    })

    const visibleCandidates = transcribeVisibleSourceHistoryFacts({
      entries: [
        {
          entryId: 'vh-doc-skip',
          sourceReference: 'DocumentReference/doc-1',
          resourceType: 'DocumentReference',
          clinicalDate: '2026-08-01T10:00:00+08:00',
          title: '外院出院小结全文',
          clinical: { conclusion: '长段叙事文书应被排除' },
        },
        {
          entryId: 'vh-cr-1',
          sourceReference: 'Observation/ext-cr-1',
          resourceType: 'Observation',
          clinicalDate: '2026-08-10T09:00:00+08:00',
          title: '外院血清肌酐',
          clinical: {
            code: { coding: [{ code: '2160-0', system: 'http://loinc.org', display: 'Creatinine' }] },
            valueQuantity: { value: 1.4, unit: 'mg/dL' },
          },
        },
      ],
    })

    const bedsideCandidates = transcribeBedsideQuestionnaireFacts({
      revisions: [
        {
          revisionId: 'ra-1',
          revisionNumber: 1,
          recordedAt: '2026-08-24T09:00:00+08:00',
          values: {
            killipClass: 'II',
            cardiacArrestOnAdmission: false,
            anginaEpisodes24h: 3,
            stSegmentDeviation: true,
            aspirinUsedLast7Days: null,
            smokingStatus: 'current',
            familyHistoryPrematureCad: null,
            knownCoronaryStenosisGe50: true,
            priorBleedingHistory: 'negative',
          },
        },
      ],
    })

    const ledger = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T10:00:00+08:00',
      candidates: [...localCandidates, ...visibleCandidates, ...bedsideCandidates],
    })

    const validated = clinicalFactLedgerSchema.parse(ledger)
    const categories = new Set(validated.facts.map(f => f.category))
    expect(categories).toEqual(new Set([
      'diagnosis',
      'allergy',
      'laboratory',
      'examination',
      'vital-sign',
      'medication',
      'procedure',
      'bedside-questionnaire',
    ]))
    expect(validated.facts.some(f => f.provenance.recordId === 'obs-draft-skip')).toBe(false)
    expect(validated.facts.some(f => f.provenance.recordId === 'med-draft')).toBe(false)
    expect(validated.facts.some(f => f.provenance.recordId === 'DocumentReference/doc-1')).toBe(false)

    const confirmedDx = validated.facts.find(f => f.provenance.recordId === 'cond-1')
    const provDx = validated.facts.find(f => f.provenance.recordId === 'cond-prov')
    expect(confirmedDx?.verificationStatus).toBe('confirmed')
    expect(provDx?.verificationStatus).toBe('provisional')

    const aspirinAsked = validated.facts.find(f => f.category === 'bedside-questionnaire' && f.itemCode.code === 'aspirin-used-last-7-days')
    const arrestAsked = validated.facts.find(f => f.category === 'bedside-questionnaire' && f.itemCode.code === 'cardiac-arrest-on-admission')
    expect(aspirinAsked?.presence).toBe('not-asked')
    expect(aspirinAsked?.value.normalizedValue).toBeNull()
    expect(aspirinAsked?.eligibleForScoringAndRedLine).toBe(false)
    expect(arrestAsked?.presence).toBe('absent')
    expect(arrestAsked?.value.normalizedValue).toBe(false)

    const extCr = validated.facts.find(f => f.provenance.sourceSystemId === 'clinmesh-visible-source-history')
    expect(extCr?.institutionScope).toBe('external')
    expect(extCr?.qualityFlags).toContain('external-unverified')
    expect(extCr?.requiresRecheckPrompt).toBe(true)
    expect(extCr?.eligibleForScoringAndRedLine).toBe(false)
  })

  it('keeps hs-cTnI, conventional cTnI, and cTnT distinct on the same specimen without merging or conflicting', () => {
    const candidates = transcribeLocalFhirFacts({
      observations: [
        {
          id: 'obs-hs-ctni',
          status: 'final',
          code: { coding: [{ code: '2100404B', display: 'hs-cTnI' }] },
          valueQuantity: { value: 52, unit: 'ng/L' },
          specimen: { reference: 'Specimen/spec-cardiac-1', display: '血清' },
          issued: '2026-08-24T09:00:00+08:00',
        },
        {
          id: 'obs-conv-ctni',
          status: 'final',
          code: { coding: [{ code: '10839-9', display: 'cTnI' }] },
          valueQuantity: { value: 0.4, unit: 'ng/mL' },
          specimen: { reference: 'Specimen/spec-cardiac-1', display: '血清' },
          issued: '2026-08-24T09:00:00+08:00',
        },
        {
          id: 'obs-ctnt',
          status: 'final',
          code: { coding: [{ code: '2100504A', display: 'cTnT' }] },
          valueQuantity: { value: 68, unit: 'ng/L' },
          specimen: { reference: 'Specimen/spec-cardiac-1', display: '血清' },
          issued: '2026-08-24T09:00:00+08:00',
        },
      ],
    })

    const ledger = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T10:00:00+08:00',
      candidates,
    })

    expect(ledger.facts).toHaveLength(3)
    expect(ledger.facts.map(f => [f.itemCode.code, f.method])).toEqual([
      ['10839-9', 'cTnI'],
      ['6597-9', 'cTnT'],
      ['89579-7', 'hs-cTnI'],
    ])
    expect(ledger.facts.every(f => f.qualityFlags.length === 0 && f.eligibleForScoringAndRedLine)).toBe(true)
  })

  it('flags suspicious rules and intra-specimen conflicts accurately and respects clinician verifications', () => {
    const candidates = transcribeLocalFhirFacts({
      observations: [
        {
          id: 'obs-bad-unit',
          status: 'final',
          code: { coding: [{ code: '2160-0', display: '肌酐' }] },
          valueQuantity: { value: 95, unit: 'mmol/L' },
          issued: '2026-08-24T09:00:00+08:00',
        },
        {
          id: 'obs-neg-range',
          status: 'final',
          code: { coding: [{ code: '2160-0', display: '肌酐' }] },
          valueQuantity: { value: -2, unit: 'mg/dL' },
          issued: '2026-08-24T09:00:00+08:00',
        },
        {
          id: 'obs-early-report',
          status: 'final',
          code: { coding: [{ code: '718-7', display: '血红蛋白' }] },
          valueQuantity: { value: 120, unit: 'g/L' },
          issued: '2026-08-24T08:00:00+08:00',
        },
        {
          id: 'obs-male-hcg',
          status: 'final',
          code: { coding: [{ code: '21198-7', display: '血清 hCG' }] },
          valueQuantity: { value: 25, unit: 'mIU/mL' },
          issued: '2026-08-24T09:00:00+08:00',
        },
        {
          id: 'obs-conflict-a',
          status: 'final',
          code: { coding: [{ code: '2160-0', display: '肌酐' }] },
          valueQuantity: { value: 1.0, unit: 'mg/dL' },
          specimen: { reference: 'Specimen/spec-dup', display: '血清' },
          issued: '2026-08-24T09:05:00+08:00',
        },
        {
          id: 'obs-conflict-b',
          status: 'final',
          code: { coding: [{ code: '1700404A', display: '肌酐' }] },
          valueQuantity: { value: 265.2, unit: 'umol/L' },
          specimen: { reference: 'Specimen/spec-dup', display: '血清' },
          issued: '2026-08-24T09:05:00+08:00',
        },
      ],
      orderedAtByObservationId: {
        'obs-early-report': '2026-08-24T09:30:00+08:00',
      },
    })

    const unverifiedLedger = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T10:00:00+08:00',
      candidates,
    })

    expect(unverifiedLedger.facts.find(f => f.provenance.recordId === 'obs-bad-unit')?.suspiciousReasons).toContain('unit-not-allowed')
    expect(unverifiedLedger.facts.find(f => f.provenance.recordId === 'obs-neg-range')?.suspiciousReasons).toContain('out-of-plausible-range')
    expect(unverifiedLedger.facts.find(f => f.provenance.recordId === 'obs-early-report')?.suspiciousReasons).toContain('reported-before-ordered')
    expect(unverifiedLedger.facts.find(f => f.provenance.recordId === 'obs-male-hcg')?.suspiciousReasons).toContain('sex-contradiction')

    const conflictA = unverifiedLedger.facts.find(f => f.provenance.recordId === 'obs-conflict-a')!
    const conflictB = unverifiedLedger.facts.find(f => f.provenance.recordId === 'obs-conflict-b')!
    expect(conflictA.qualityFlags).toContain('conflict')
    expect(conflictB.qualityFlags).toContain('conflict')
    expect(conflictA.conflictingFactIds).toEqual([conflictB.factId])
    expect(conflictB.conflictingFactIds).toEqual([conflictA.factId])
    expect(conflictA.eligibleForScoringAndRedLine).toBe(false)
    expect(conflictB.eligibleForScoringAndRedLine).toBe(false)

    // Clinician formally verifies conflictB at 10:15; check both before and after verification
    const verifications = [
      {
        verificationId: 'ver-1',
        subjectKind: 'outpatient' as const,
        subjectId: 'case-1',
        patientId: 'pat-1',
        factId: conflictB.factId,
        itemCode: conflictB.itemCode.code,
        sourceReference: 'Observation/obs-conflict-b',
        sourceVersion: '1',
        decision: 'verified' as const,
        note: '手工复测核实以 265.2 umol/L 为准',
        verifiedAt: '2026-08-24T10:15:00+08:00',
        verifiedByActorId: 'actor-doc',
        verifiedByPractitionerId: 'prac-doc',
        verifiedByPractitionerRoleId: 'role-doc',
      },
    ]

    const at1005 = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T10:05:00+08:00',
      candidates,
      verifications,
    })
    expect(at1005.facts.find(f => f.factId === conflictB.factId)?.eligibleForScoringAndRedLine).toBe(false)

    const at1030 = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T02:30:00.000Z', // UTC equivalent of 10:30+08:00
      candidates,
      verifications,
    })
    const verifiedConflictB = at1030.facts.find(f => f.factId === conflictB.factId)!
    expect(verifiedConflictB.clinicianVerification.verified).toBe(true)
    expect(verifiedConflictB.eligibleForScoringAndRedLine).toBe(true)
    expect(at1030.facts.find(f => f.factId === conflictA.factId)?.eligibleForScoringAndRedLine).toBe(false)
  })

  it('enforces point-in-time asOf cutoff and v1->v2 amendment superseding without future leakage', () => {
    const candidates = transcribeLocalFhirFacts({
      diagnosticReports: [
        {
          id: 'rep-v1',
          status: 'final',
          code: { coding: [{ code: '2160-0', display: '肌酐' }] },
          result: [{ reference: 'Observation/obs-v1' }],
          issued: '2026-08-24T09:00:00+08:00',
          meta: { versionId: '1', lastUpdated: '2026-08-24T09:00:00+08:00' },
        },
        {
          id: 'rep-v2',
          status: 'amended',
          code: { coding: [{ code: '2160-0', display: '肌酐' }] },
          result: [{ reference: 'Observation/obs-v2' }],
          issued: '2026-08-24T11:00:00+08:00',
          meta: { versionId: '1', lastUpdated: '2026-08-24T11:00:00+08:00' },
        },
      ],
      observations: [
        {
          id: 'obs-v1',
          status: 'final',
          code: { coding: [{ code: '2160-0', display: '肌酐' }] },
          valueQuantity: { value: 1.1, unit: 'mg/dL' },
          issued: '2026-08-24T09:00:00+08:00',
          meta: { versionId: '1', lastUpdated: '2026-08-24T09:00:00+08:00' },
        },
        {
          id: 'obs-v2',
          status: 'amended',
          code: { coding: [{ code: '2160-0', display: '肌酐' }] },
          valueQuantity: { value: 2.3, unit: 'mg/dL' },
          issued: '2026-08-24T11:00:00+08:00',
          meta: { versionId: '1', lastUpdated: '2026-08-24T11:00:00+08:00' },
        },
      ],
      supersedesReportId: {
        'rep-v2': 'rep-v1',
      },
    })

    const at1000 = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T10:00:00+08:00',
      candidates,
    })
    expect(at1000.facts).toHaveLength(1)
    expect(at1000.facts[0]?.provenance.recordId).toBe('obs-v1')
    expect(at1000.facts[0]?.recordStatus).toBe('final')
    expect(at1000.facts[0]?.relation.supersededByFactId).toBeNull()
    expect(at1000.facts[0]?.eligibleForScoringAndRedLine).toBe(true)

    const at1200ActiveOnly = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T12:00:00+08:00',
      candidates,
    })
    expect(at1200ActiveOnly.facts).toHaveLength(1)
    expect(at1200ActiveOnly.facts[0]?.provenance.recordId).toBe('obs-v2')
    expect(at1200ActiveOnly.facts[0]?.recordStatus).toBe('amended')
    expect(at1200ActiveOnly.facts[0]?.relation.supersedesFactId).toContain('obs-v1')
    expect(at1200ActiveOnly.facts[0]?.eligibleForScoringAndRedLine).toBe(true)

    const at1200WithSuperseded = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T12:00:00+08:00',
      includeSuperseded: true,
      candidates,
    })
    expect(at1200WithSuperseded.facts).toHaveLength(2)
    const v1Superseded = at1200WithSuperseded.facts.find(f => f.provenance.recordId === 'obs-v1')!
    expect(v1Superseded.relation.supersededByFactId).toContain('obs-v2')
    expect(v1Superseded.eligibleForScoringAndRedLine).toBe(false)
    expect(v1Superseded.ineligibleReasons).toContain('superseded')
  })

  it('preserves per-version ingestedAt timestamps when an Observation is amended under the same Observation ID', () => {
    const sharedObsId = 'l0-sim-lis-cr-001'
    const candidates = transcribeLocalFhirFacts({
      ingestedAtByObservationId: {
        [`${sharedObsId}::1`]: '2026-08-24T09:05:00+08:00',
        [`${sharedObsId}::2`]: '2026-08-24T11:05:00+08:00',
      },
      observations: [
        {
          id: sharedObsId,
          status: 'final',
          code: { coding: [{ code: '2160-0', display: '肌酐' }] },
          valueQuantity: { value: 1.0, unit: 'mg/dL' },
          issued: '2026-08-24T09:00:00+08:00',
          meta: { versionId: '1', lastUpdated: '2026-08-24T09:00:00+08:00' },
        },
        {
          id: sharedObsId,
          status: 'amended',
          code: { coding: [{ code: '2160-0', display: '肌酐' }] },
          valueQuantity: { value: 1.8, unit: 'mg/dL' },
          issued: '2026-08-24T11:00:00+08:00',
          meta: { versionId: '2', lastUpdated: '2026-08-24T11:00:00+08:00' },
        },
      ],
      sourceSystemIdByObservationId: {
        [`${sharedObsId}::1`]: 'clinmesh-sim-lis-v2',
        [`${sharedObsId}::2`]: 'clinmesh-sim-lis-v2',
      },
    })

    const atMidpoint = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T10:00:00+08:00',
      candidates,
    })
    expect(atMidpoint.facts).toHaveLength(1)
    expect(atMidpoint.facts[0]?.provenance.recordVersion).toBe('1')
    expect(atMidpoint.facts[0]?.value.normalizedValue).toEqual({ unit: 'mg/dL', value: 1.0 })
    expect(atMidpoint.facts[0]?.ingestedAt).toBe('2026-08-24T09:05:00+08:00')

    const atLatest = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T12:00:00+08:00',
      candidates,
    })
    expect(atLatest.facts.find(f => f.provenance.recordVersion === '2')?.ingestedAt).toBe('2026-08-24T11:05:00+08:00')
  })

  it('enforces public validity defaults and tightenValidityDays monotonicity', () => {
    expect(getPublicValidityDays('2160-0')).toBe(90)
    expect(getPublicValidityDays('1700404A')).toBe(90)
    expect(getPublicValidityDays('4548-4')).toBe(90)
    expect(getPublicValidityDays('13457-7')).toBe(180)
    expect(getPublicValidityDays('8867-4')).toBe(7)

    expect(tightenValidityDays('2160-0', 30)).toBe(30)
    expect(() => tightenValidityDays('2160-0', 91)).toThrow()
    expect(() => tightenValidityDays('8867-4', 8)).toThrow()
    expect(() => tightenValidityDays('2160-0', 0)).toThrow()

    const oldCandidate = transcribeLocalFhirFacts({
      observations: [
        {
          id: 'obs-old-cr',
          status: 'final',
          code: { coding: [{ code: '2160-0', display: '肌酐' }] },
          valueQuantity: { value: 1.0, unit: 'mg/dL' },
          effectiveDateTime: '2026-05-01T09:00:00+08:00',
          issued: '2026-05-01T10:00:00+08:00',
        },
      ],
    })

    const ledger = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-08-24T10:00:00+08:00',
      candidates: oldCandidate,
      validityDaysOverrides: { '2160-0': 30 },
    })

    expect(ledger.facts[0]?.validityDays).toBe(30)
    expect(ledger.facts[0]?.isExpiredAtAsOf).toBe(true)
    expect(ledger.facts[0]?.eligibleForScoringAndRedLine).toBe(false)
    expect(ledger.facts[0]?.ineligibleReasons).toContain('expired')
    expect(ledger.summary.expiredCount).toBe(1)
  })

  it('does not self-conflict a laboratory DiagnosticReport conclusion boilerplate against its own Observation on the same specimen', () => {
    const candidates = transcribeLocalFhirFacts({
      diagnosticReports: [
        {
          id: 'dr-scr-1',
          status: 'final',
          code: { coding: [{ code: '2160-0', display: '肌酐（质量浓度）' }] },
          specimen: [{ reference: 'Specimen/sp-scr-1' }],
          result: [{ reference: 'Observation/obs-scr-1' }],
          issued: '2026-08-24T09:00:00+08:00',
          conclusion: 'ClinMesh 固定合成资料支持的检验结果，仅用于仿真。',
        },
      ],
      observations: [
        {
          id: 'obs-scr-1',
          status: 'final',
          category: [{ coding: [{ code: 'laboratory' }] }],
          code: { coding: [{ code: '2160-0', display: '血清肌酐' }] },
          specimen: { reference: 'Specimen/sp-scr-1' },
          valueQuantity: { value: 0.9, unit: 'mg/dL', code: 'mg/dL' },
          effectiveDateTime: '2026-08-24T09:00:00+08:00',
          issued: '2026-08-24T09:00:00+08:00',
        },
      ],
    })

    const ledger = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'inpatient',
      subjectId: 'adm-1',
      evaluatedAsOf: '2026-08-24T09:00:00+08:00',
      candidates,
    })

    expect(ledger.facts).toHaveLength(1)
    expect(ledger.facts[0]?.provenance.recordId).toBe('obs-scr-1')
    expect(ledger.facts[0]?.qualityFlags).toEqual([])
    expect(ledger.facts[0]?.eligibleForScoringAndRedLine).toBe(true)
  })

  it('propagates custom sourceSystemId across all six local FHIR resource types and detects order-independent conflicts', () => {
    const candidates = transcribeLocalFhirFacts({
      allergyIntolerances: [
        {
          code: { coding: [{ code: 'allergy-asa', display: '阿司匹林' }] },
          id: 'all-custom',
          recordedDate: '2026-08-24T08:00:00+08:00',
          verificationStatus: { coding: [{ code: 'confirmed' }] },
        },
      ],
      conditions: [
        {
          code: { coding: [{ code: 'I25.103', display: '冠心病' }] },
          id: 'cond-custom',
          recordedDate: '2026-08-24T08:00:00+08:00',
          verificationStatus: { coding: [{ code: 'confirmed' }] },
        },
      ],
      diagnosticReports: [
        {
          category: [{ coding: [{ code: 'ECG' }] }],
          code: { coding: [{ code: '11524-6', display: '十二导联心电图' }] },
          conclusion: '窦性心律',
          effectiveDateTime: '2026-08-24T08:00:00+08:00',
          id: 'rep-custom',
          issued: '2026-08-24T08:05:00+08:00',
          status: 'final',
        },
      ],
      medications: [
        {
          authoredOn: '2026-08-24T08:00:00+08:00',
          id: 'med-custom',
          medicationCodeableConcept: { coding: [{ code: 'aspirin', display: '阿司匹林' }] },
          resourceType: 'MedicationRequest',
          status: 'active',
        },
      ],
      observations: [
        {
          code: { coding: [{ code: '2160-0', display: '血清肌酐' }] },
          effectiveDateTime: '2026-08-24T08:00:00+08:00',
          id: 'obs-custom',
          issued: '2026-08-24T08:05:00+08:00',
          status: 'final',
          valueQuantity: { unit: 'umol/L', value: 88 },
        },
      ],
      procedures: [
        {
          code: { coding: [{ code: '36.0700', display: 'PCI' }] },
          id: 'proc-custom',
          performedDateTime: '2026-08-24T08:10:00+08:00',
          recorded: '2026-08-24T08:15:00+08:00',
          status: 'completed',
        },
      ],
      sourceSystemId: 'custom-ward-lis',
    })

    expect(candidates).toHaveLength(6)
    expect(candidates.every(c => c.provenance.sourceSystemId === 'custom-ward-lis')).toBe(true)
    expect(candidates.every(c => c.factId.startsWith('fact:custom-ward-lis:'))).toBe(true)
  })
})
