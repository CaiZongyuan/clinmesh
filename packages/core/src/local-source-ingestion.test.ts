import { describe, expect, it } from 'vitest'
import {
  PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
  SIM_LIS_V2_SOURCE_SYSTEM_ID,
} from '@clinmesh/contracts/local-source-ingestion'
import {
  evaluateClinicalFactLedger,
  transcribeLocalFhirFacts,
} from './clinical-fact-ledger.ts'
import {
  compareSourceSystemLedgers,
  isBatchComplete,
  matchSourcePatientIdentity,
  normalizePrimaryLisReportToFhir,
  normalizeSimLisV2ReportToFhir,
  type LocalPatientIndexEntry,
} from './local-source-ingestion.ts'

describe('local-source-ingestion core adapters, patient matching, and batch completeness', () => {
  it.each([
    {
      name: 'Creatinine mg/dL (sim-lis-v2) vs umol/L (primary)',
      simRecord: {
        externalReportId: 'lis2-crea-1',
        orderId: 'ord-1',
        analyte_local_code: 'CREA',
        analyte_label: '肌酐',
        result_num: 1.33,
        uom_text: 'mg/dL',
        collected_ts: '2026-11-24T08:10:00+08:00',
        released_ts: '2026-11-24T09:00:00+08:00',
        ordered_ts: '2026-11-24T08:00:00+08:00',
        report_status: 'final' as const,
        version: 1,
        specimen_type: '血清',
        method_text: '酶法',
      },
      primaryRecord: {
        externalReportId: 'his-crea-1',
        orderId: 'ord-1',
        loincCode: '2160-0',
        display: '血清肌酐',
        value: 117.572,
        unit: 'umol/L',
        effectiveDateTime: '2026-11-24T08:10:00+08:00',
        issued: '2026-11-24T09:00:00+08:00',
        orderedAt: '2026-11-24T08:00:00+08:00',
        status: 'final' as const,
        version: 1,
        specimenLabel: 'Serum',
        methodText: 'Enzymatic',
      },
      expectedCode: '2160-0',
      expectedNormalized: { value: 1.33, unit: 'mg/dL' },
    },
    {
      name: 'hs-cTnI ng/mL (sim-lis-v2) vs ng/L (primary)',
      simRecord: {
        externalReportId: 'lis2-hsctni-1',
        orderId: 'ord-2',
        analyte_local_code: 'HS-CTNI',
        analyte_label: '高敏肌钙蛋白I',
        result_num: 0.045,
        uom_text: 'ng/mL',
        collected_ts: '2026-11-24T08:12:00+08:00',
        released_ts: '2026-11-24T08:50:00+08:00',
        report_status: 'final' as const,
        version: 1,
        specimen_type: '静脉血',
      },
      primaryRecord: {
        externalReportId: 'his-hsctni-1',
        loincCode: '89579-7',
        display: '高敏肌钙蛋白I (hs-cTnI)',
        value: 45,
        unit: 'ng/L',
        effectiveDateTime: '2026-11-24T08:12:00+08:00',
        issued: '2026-11-24T08:50:00+08:00',
        status: 'final' as const,
        version: 1,
        specimenLabel: 'Venous blood',
      },
      expectedCode: '89579-7',
      expectedNormalized: { value: 45, unit: 'ng/L' },
    },
    {
      name: 'LDL-C mg/dL (sim-lis-v2) vs mmol/L (primary)',
      simRecord: {
        externalReportId: 'lis2-ldl-1',
        orderId: 'ord-3',
        analyte_local_code: 'LDL-C',
        analyte_label: '低密度脂蛋白',
        result_num: 77.34,
        uom_text: 'mg/dL',
        collected_ts: '2026-11-24T08:15:00+08:00',
        released_ts: '2026-11-24T09:10:00+08:00',
        report_status: 'final' as const,
        version: 1,
      },
      primaryRecord: {
        externalReportId: 'his-ldl-1',
        loincCode: '13457-7',
        display: '低密度脂蛋白胆固醇 (LDL-C)',
        value: 2,
        unit: 'mmol/L',
        effectiveDateTime: '2026-11-24T08:15:00+08:00',
        issued: '2026-11-24T09:10:00+08:00',
        status: 'final' as const,
        version: 1,
      },
      expectedCode: '13457-7',
      expectedNormalized: { value: 2, unit: 'mmol/L' },
    },
    {
      name: 'Potassium mEq/L (sim-lis-v2) vs mmol/L (primary)',
      simRecord: {
        externalReportId: 'lis2-k-1',
        orderId: 'ord-4',
        analyte_local_code: 'K',
        analyte_label: '钾',
        result_num: 4.2,
        uom_text: 'mEq/L',
        collected_ts: '2026-11-24T08:15:00+08:00',
        released_ts: '2026-11-24T09:05:00+08:00',
        report_status: 'final' as const,
        version: 1,
      },
      primaryRecord: {
        externalReportId: 'his-k-1',
        loincCode: '2823-3',
        display: '血清钾 (K+)',
        value: 4.2,
        unit: 'mmol/L',
        effectiveDateTime: '2026-11-24T08:15:00+08:00',
        issued: '2026-11-24T09:05:00+08:00',
        status: 'final' as const,
        version: 1,
      },
      expectedCode: '2823-3',
      expectedNormalized: { value: 4.2, unit: 'mmol/L' },
    },
    {
      name: 'HbA1c % and Creatinine micro symbol (μmol/L)',
      simRecord: {
        externalReportId: 'lis2-hba1c-1',
        orderId: 'ord-5',
        analyte_local_code: 'HBA1C',
        analyte_label: '糖化血红蛋白',
        result_num: 7.4,
        uom_text: '%',
        collected_ts: '2026-11-24T08:20:00+08:00',
        released_ts: '2026-11-24T09:20:00+08:00',
        report_status: 'corrected' as const,
        version: 2,
      },
      primaryRecord: {
        externalReportId: 'his-hba1c-1',
        loincCode: '4548-4',
        display: '糖化血红蛋白 (HbA1c)',
        value: 7.4,
        unit: '%',
        effectiveDateTime: '2026-11-24T08:20:00+08:00',
        issued: '2026-11-24T09:20:00+08:00',
        status: 'amended' as const,
        version: 2,
      },
      expectedCode: '4548-4',
      expectedNormalized: { value: 7.4, unit: '%' },
    },
  ])('AC37: produces identical normalized facts across sources while preserving provenance.sourceSystemId ($name)', ({
    simRecord,
    primaryRecord,
    expectedCode,
    expectedNormalized,
  }) => {
    const ingestedAt = '2026-11-24T09:30:00+08:00'
    const simNormalized = normalizeSimLisV2ReportToFhir({
      record: simRecord,
      batchId: 'batch-sim-1',
      localPatientId: 'pat-1',
      ingestedAt,
      specimenBarcode: 'SB-001',
    })
    const primaryNormalized = normalizePrimaryLisReportToFhir({
      record: primaryRecord,
      batchId: 'batch-primary-1',
      localPatientId: 'pat-1',
      ingestedAt,
      specimenBarcode: 'SB-001',
    })

    const simLedger = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-sim-1',
      evaluatedAsOf: '2026-11-24T10:00:00+08:00',
      candidates: transcribeLocalFhirFacts({
        observations: [simNormalized.observation],
        ...(simNormalized.provenance.orderedAt
          ? { orderedAtByObservationId: { [simNormalized.observation.id]: simNormalized.provenance.orderedAt } }
          : {}),
        sourceSystemIdByObservationId: { [simNormalized.observation.id]: SIM_LIS_V2_SOURCE_SYSTEM_ID },
        ingestedAtByObservationId: { [simNormalized.observation.id]: simNormalized.provenance.ingestedAt },
      }),
    })

    const primaryLedger = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-primary-1',
      evaluatedAsOf: '2026-11-24T10:00:00+08:00',
      candidates: transcribeLocalFhirFacts({
        observations: [primaryNormalized.observation],
        ...(primaryNormalized.provenance.orderedAt
          ? { orderedAtByObservationId: { [primaryNormalized.observation.id]: primaryNormalized.provenance.orderedAt } }
          : {}),
        sourceSystemIdByObservationId: { [primaryNormalized.observation.id]: PRIMARY_LOCAL_SOURCE_SYSTEM_ID },
        ingestedAtByObservationId: { [primaryNormalized.observation.id]: primaryNormalized.provenance.ingestedAt },
      }),
    })

    expect(simLedger.facts).toHaveLength(1)
    expect(primaryLedger.facts).toHaveLength(1)
    expect(simLedger.facts[0]!.itemCode.code).toBe(expectedCode)
    expect(simLedger.facts[0]!.value.normalizedValue).toEqual(expectedNormalized)
    expect(simLedger.facts[0]!.provenance.sourceSystemId).toBe(SIM_LIS_V2_SOURCE_SYSTEM_ID)
    expect(primaryLedger.facts[0]!.provenance.sourceSystemId).toBe(PRIMARY_LOCAL_SOURCE_SYSTEM_ID)

    const comparison = compareSourceSystemLedgers({
      leftSourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
      leftLedger: primaryLedger,
      rightSourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      rightLedger: simLedger,
    })
    expect(comparison).toEqual({
      identicalNormalizedFacts: true,
      mismatches: [],
      sourceSystemsCompared: [PRIMARY_LOCAL_SOURCE_SYSTEM_ID, SIM_LIS_V2_SOURCE_SYSTEM_ID],
      comparedFactCount: 1,
    })
  })

  it('normalizes Unicode micro symbol (μmol/L -> umol/L), links v2 amended revisions, and lets L2 flag invalid units', () => {
    const v1 = normalizeSimLisV2ReportToFhir({
      record: {
        externalReportId: 'lis2-crea-rev',
        orderId: 'ord-rev',
        analyte_local_code: 'CREA',
        analyte_label: '肌酐',
        result_num: 117.572,
        uom_text: 'μmol/L',
        collected_ts: '2026-11-24T08:00:00+08:00',
        released_ts: '2026-11-24T08:30:00+08:00',
        report_status: 'final',
        version: 1,
      },
      batchId: 'batch-1',
      localPatientId: 'pat-1',
      ingestedAt: '2026-11-24T08:35:00+08:00',
    })
    expect(v1.observation.valueQuantity?.unit).toBe('umol/L')

    const v2 = normalizeSimLisV2ReportToFhir({
      record: {
        externalReportId: 'lis2-crea-rev',
        orderId: 'ord-rev',
        analyte_local_code: 'CREA',
        analyte_label: '肌酐',
        result_num: 132.6,
        uom_text: 'μmol/L',
        collected_ts: '2026-11-24T08:00:00+08:00',
        released_ts: '2026-11-24T09:00:00+08:00',
        report_status: 'amended',
        version: 2,
      },
      batchId: 'batch-2',
      localPatientId: 'pat-1',
      ingestedAt: '2026-11-24T09:05:00+08:00',
    })

    const badUnit = normalizeSimLisV2ReportToFhir({
      record: {
        externalReportId: 'lis2-crea-bad-unit',
        orderId: 'ord-bad',
        analyte_local_code: 'CREA',
        analyte_label: '肌酐',
        result_num: 1.33,
        uom_text: 'mmol/L',
        collected_ts: '2026-11-24T08:00:00+08:00',
        released_ts: '2026-11-24T09:00:00+08:00',
        report_status: 'final',
        version: 1,
      },
      batchId: 'batch-3',
      localPatientId: 'pat-1',
      ingestedAt: '2026-11-24T09:05:00+08:00',
    })

    const ledger = evaluateClinicalFactLedger({
      patientId: 'pat-1',
      patientSex: 'male',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      evaluatedAsOf: '2026-11-24T10:00:00+08:00',
      includeSuperseded: true,
      candidates: transcribeLocalFhirFacts({
        observations: [v1.observation, v2.observation, badUnit.observation],
        sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      }),
    })

    const revFacts = ledger.facts.filter(f => f.provenance.recordId === v1.observation.id)
    expect(revFacts).toHaveLength(2)
    const rev1 = revFacts.find(f => f.provenance.recordVersion === '1')!
    const rev2 = revFacts.find(f => f.provenance.recordVersion === '2')!
    expect(rev2.relation.supersedesFactId).toBe(rev1.factId)
    expect(rev1.relation.supersededByFactId).toBe(rev2.factId)

    const badFact = ledger.facts.find(f => f.provenance.recordId === badUnit.observation.id)!
    expect(badFact.suspiciousReasons).toContain('unit-not-allowed')
    expect(badFact.eligibleForScoringAndRedLine).toBe(false)
  })

  describe('AC38: deterministic patient identity matching & quarantine rules', () => {
    const localPatients: readonly LocalPatientIndexEntry[] = [
      {
        localPatientId: 'pat-local-100',
        fullName: '张伟',
        birthDate: '1968-05-14',
        nationalId: '110101196805140013',
        phone: '13800138001',
        linkedExternalIds: [
          {
            sourceSystemId: 'clinmesh-linked-lis',
            externalPatientId: 'linked-ext-100',
          },
        ],
      },
      {
        localPatientId: 'pat-local-200',
        fullName: '李秀英',
        birthDate: '1959-11-02',
        nationalId: '110101195911020028',
        phone: '13900139002',
      },
    ]

    it.each([
      {
        label: 'Rule 1: same fullName but different birthDate -> distinct-patient (never merge homonym)',
        sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
        payload: {
          externalPatientId: 'lis2-homonym-1',
          fullName: '张伟',
          birthDate: '1981-07-22',
          nationalId: '110101198107220015',
          phone: '13800138001',
        },
        expectedDecision: 'distinct-patient',
        expectedResolution: 'rejected-distinct',
        expectedLocalPatientId: null,
        maxConfidence: 0.3,
        expectedReason: 'homonym-birth-date-mismatch',
      },
      {
        label: 'Rule 1b: externalPatientId/localPatientId collision with different birthDate -> distinct-patient',
        sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
        payload: {
          externalPatientId: 'pat-local-100',
          localPatientId: 'pat-local-100',
          fullName: '张伟',
          birthDate: '1990-01-01',
          nationalId: '110101199001010011',
        },
        expectedDecision: 'distinct-patient',
        expectedResolution: 'rejected-distinct',
        expectedLocalPatientId: null,
        maxConfidence: 0.3,
        expectedReason: 'external-id-collision-birth-date-mismatch',
      },
      {
        label: 'Rule 2a: exact localPatientId + birthDate + nationalId + fullName -> auto-matched',
        sourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
        payload: {
          externalPatientId: 'pat-local-100',
          localPatientId: 'pat-local-100',
          fullName: '张伟',
          birthDate: '1968-05-14',
          nationalId: '110101196805140013',
        },
        expectedDecision: 'matched',
        expectedResolution: 'auto-matched',
        expectedLocalPatientId: 'pat-local-100',
        minConfidence: 0.9,
      },
      {
        label: 'Rule 2b: verified external-to-local link + birthDate + nationalId + fullName -> auto-matched',
        sourceSystemId: 'clinmesh-linked-lis',
        payload: {
          externalPatientId: 'linked-ext-100',
          fullName: '张伟',
          birthDate: '1968-05-14',
          nationalId: '110101196805140013',
          phone: '13800138001',
        },
        expectedDecision: 'matched',
        expectedResolution: 'auto-matched',
        expectedLocalPatientId: 'pat-local-100',
        minConfidence: 0.9,
      },
      {
        label: 'Rule 3a: unlinked second-system ID + same nationalId & birthDate + matching phone -> quarantined (<0.90)',
        sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
        payload: {
          externalPatientId: 'lis2-unlinked-100',
          fullName: '张伟',
          birthDate: '1968-05-14',
          nationalId: '110101196805140013',
          phone: '13800138001',
        },
        expectedDecision: 'quarantined',
        expectedResolution: 'pending-review',
        expectedLocalPatientId: 'pat-local-100',
        maxConfidence: 0.89,
        minConfidence: 0.7,
        expectedReason: 'external-patient-id-unlinked',
      },
      {
        label: 'Rule 3b: unlinked ID + same nationalId & birthDate + name spacing + changed phone -> quarantined',
        sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
        payload: {
          externalPatientId: 'lis2-unlinked-200',
          fullName: '李 秀英',
          birthDate: '1959-11-02',
          nationalId: '110101195911020028',
          phone: '13999999999',
        },
        expectedDecision: 'quarantined',
        expectedResolution: 'pending-review',
        expectedLocalPatientId: 'pat-local-200',
        maxConfidence: 0.89,
        minConfidence: 0.6,
        expectedReason: 'name-formatting-variance',
      },
      {
        label: 'Rule 1c: same birthDate & fullName but conflicting real nationalId -> distinct-patient',
        sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
        payload: {
          externalPatientId: 'lis2-diff-natid',
          fullName: '张伟',
          birthDate: '1968-05-14',
          nationalId: '110101196805149999',
        },
        expectedDecision: 'distinct-patient',
        expectedResolution: 'rejected-distinct',
        expectedLocalPatientId: null,
        maxConfidence: 0.3,
        expectedReason: 'national-id-mismatch',
      },
    ])('$label', ({
      sourceSystemId,
      payload,
      expectedDecision,
      expectedResolution,
      expectedLocalPatientId,
      minConfidence,
      maxConfidence,
      expectedReason,
    }) => {
      const candidate = matchSourcePatientIdentity({
        candidateId: 'cand-test-1',
        sourceSystemId,
        batchId: 'batch-test-1',
        patientPayload: payload,
        localPatients,
      })

      expect(candidate.decision).toBe(expectedDecision)
      expect(candidate.resolutionStatus).toBe(expectedResolution)
      expect(candidate.matchedLocalPatientId).toBe(expectedLocalPatientId)
      if (minConfidence !== undefined) expect(candidate.confidenceScore).toBeGreaterThanOrEqual(minConfidence)
      if (maxConfidence !== undefined) expect(candidate.confidenceScore).toBeLessThanOrEqual(maxConfidence)
      if (expectedReason) expect(candidate.mismatchReasons).toContain(expectedReason)
    })
  })

  it.each([
    { expected: 10, received: 0, complete: false },
    { expected: 10, received: 6, complete: false },
    { expected: 10, received: 9, complete: false },
    { expected: 10, received: 10, complete: true },
    { expected: 10, received: 11, complete: false },
    { expected: 0, received: 0, complete: false },
    { expected: -1, received: -1, complete: false },
  ])('AC39: isBatchComplete($expected, $received) -> $complete', ({ expected, received, complete }) => {
    expect(isBatchComplete(expected, received)).toBe(complete)
  })
})
