import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { clinicalFactSchema, type ClinicalFact } from '../src/clinical-fact-ledger.ts'
import {
  confirmIdentityQuarantineMergeBodySchema,
  confirmIdentityQuarantineMergeInputSchema,
  confirmIdentityQuarantineMergeResponseSchema,
  DEFAULT_LOCAL_INGESTION_HOSPITAL_ID,
  DEFAULT_PATIENT_MATCH_CONFIDENCE_THRESHOLD,
  evaluateSourceAgnosticismResult,
  ingestLocalSourceBatchRequestSchema,
  ingestLocalSourceBatchResponseSchema,
  listIdentityQuarantineQuerySchema,
  listIdentityQuarantineResponseSchema,
  localIngestionBatchContractSchema,
  patientIdentityCandidateSchema,
  PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
  SIM_LIS_V2_SOURCE_SYSTEM_ID,
  sourceAgnosticismResultSchema,
} from '../src/local-source-ingestion.ts'

function makeSampleClinicalFact(overrides: Partial<ClinicalFact> & { sourceSystemId?: string } = {}): ClinicalFact {
  const sourceSystemId = overrides.sourceSystemId ?? PRIMARY_LOCAL_SOURCE_SYSTEM_ID
  const { sourceSystemId: _unused, ...factOverrides } = overrides
  return clinicalFactSchema.parse({
    factId: `fact-${sourceSystemId}-2160-0-1`,
    category: 'laboratory',
    itemCode: {
      code: '2160-0',
      system: 'http://loinc.org',
      display: 'Creatinine [Mass/volume] in Serum or Plasma',
    },
    value: {
      rawText: '117.572 umol/L',
      normalizedValue: { value: 1.33, unit: 'mg/dL' },
    },
    method: 'Enzymatic',
    specimenOrSite: { label: 'Serum', specimenId: null },
    orderedAt: '2026-11-24T08:00:00+08:00',
    effectiveAt: '2026-11-24T08:15:00+08:00',
    reportedAt: '2026-11-24T09:00:00+08:00',
    provenance: {
      recordType: 'Observation',
      recordId: `obs-${sourceSystemId}-1`,
      recordVersion: '1',
      sourceSystemId,
    },
    institutionScope: 'local',
    recordStatus: 'final',
    presence: 'present',
    relation: {
      supersedesFactId: null,
      supersededByFactId: null,
    },
    verificationStatus: 'not-applicable',
    ingestedAt: '2026-11-24T09:05:00+08:00',
    mappingVersion: 'clinmesh-fact-map-v1',
    qualityFlags: [],
    suspiciousReasons: [],
    conflictingFactIds: [],
    requiresRecheckPrompt: false,
    validityDays: 30,
    isExpiredAtAsOf: false,
    clinicianVerification: {
      verified: false,
      verifiedAt: null,
      verifiedByActorId: null,
      verifiedByPractitionerId: null,
      note: null,
    },
    eligibleForScoringAndRedLine: true,
    ineligibleReasons: [],
    ...factOverrides,
  })
}

describe('local-source-ingestion contracts', () => {
  it('validates L0 batch contract and defaults', () => {
    const parsed = localIngestionBatchContractSchema.parse({
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      hospitalId: DEFAULT_LOCAL_INGESTION_HOSPITAL_ID,
      batchId: 'batch-lis2-20261124-01',
      expectedItemCount: 10,
      receivedItemCount: 6,
      batchStatus: 'incomplete',
      ingestedAt: '2026-11-24T09:00:00+08:00',
    })
    expect(parsed.hospitalId).toBe('hospital-synthetic-clinmesh')
    expect(parsed.batchStatus).toBe('incomplete')

    expect(() =>
      localIngestionBatchContractSchema.parse({
        sourceSystemId: 'Bad Source!',
        hospitalId: DEFAULT_LOCAL_INGESTION_HOSPITAL_ID,
        batchId: 'b1',
        expectedItemCount: 1,
        receivedItemCount: 1,
        batchStatus: 'complete',
        ingestedAt: '2026-11-24T09:00:00+08:00',
      }),
    ).toThrow()
  })

  it('validates sim-lis-v2 and primary HIS payloads strictly', () => {
    const simPayload = ingestLocalSourceBatchRequestSchema.parse({
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      batchId: 'batch-lis2-001',
      expectedItemCount: 2,
      specimen_barcode: 'SB-9001',
      patient_ref: {
        externalPatientId: 'lis2-p-100',
        fullName: '陈志强',
        birthDate: '1965-04-12',
        nationalId: '11010119650412001X',
        phone: '13800138000',
      },
      records: [
        {
          externalReportId: 'rep-201',
          orderId: 'ord-201',
          analyte_local_code: 'CREA',
          analyte_label: '肌酐',
          result_num: 1.33,
          uom_text: 'mg/dL',
          collected_ts: '2026-11-24T08:15:00+08:00',
          released_ts: '2026-11-24T09:00:00+08:00',
          report_status: 'final',
          version: 1,
        },
      ],
    })
    expect(simPayload).toHaveProperty('specimen_barcode', 'SB-9001')

    const primaryPayload = ingestLocalSourceBatchRequestSchema.parse({
      sourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID,
      batchId: 'batch-his-001',
      expectedItemCount: 1,
      patientRef: {
        externalPatientId: 'patient-001',
        localPatientId: 'patient-001',
        fullName: '陈志强',
        birthDate: '1965-04-12',
        nationalId: '11010119650412001X',
      },
      records: [
        {
          externalReportId: 'his-rep-1',
          loincCode: '2160-0',
          display: 'Creatinine',
          value: 117.572,
          unit: 'umol/L',
          effectiveDateTime: '2026-11-24T08:15:00+08:00',
          issued: '2026-11-24T09:00:00+08:00',
          status: 'final',
          version: 1,
        },
      ],
    })
    expect(primaryPayload.sourceSystemId).toBe('clinmesh-his-fhir')

    expect(() =>
      ingestLocalSourceBatchRequestSchema.parse({
        sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
        batchId: 'batch-bad',
        expectedItemCount: 1,
        specimen_barcode: 'SB-1',
        patient_ref: {
          externalPatientId: 'p1',
          fullName: '测试',
          birthDate: '1980-01-01',
          nationalId: '110101198001010011',
        },
        records: [],
      }),
    ).toThrow()
  })

  it('validates PatientIdentityCandidate and quarantine schemas', () => {
    const candidate = patientIdentityCandidateSchema.parse({
      candidateId: 'cand-1',
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      externalPatientId: 'lis2-ext-99',
      batchId: 'batch-1',
      patientPayload: {
        externalPatientId: 'lis2-ext-99',
        fullName: '周建华',
        birthDate: '1970-02-03',
        nationalId: '110101197002030019',
        phone: null,
      },
      matchedLocalPatientId: 'patient-01',
      confidenceScore: 0.78,
      confidenceThreshold: DEFAULT_PATIENT_MATCH_CONFIDENCE_THRESHOLD,
      decision: 'quarantined',
      mismatchReasons: ['external-patient-id-unlinked', 'phone-missing'],
      resolutionStatus: 'pending-review',
      resolvedByActorId: null,
      resolvedAt: null,
      auditNote: null,
    })
    expect(candidate.decision).toBe('quarantined')
  })

  it('supports JSON Schema generation for all catalog-facing and API schemas', () => {
    for (const schema of [
      listIdentityQuarantineQuerySchema,
      listIdentityQuarantineResponseSchema,
      confirmIdentityQuarantineMergeBodySchema,
      confirmIdentityQuarantineMergeInputSchema,
      confirmIdentityQuarantineMergeResponseSchema,
      ingestLocalSourceBatchRequestSchema,
      ingestLocalSourceBatchResponseSchema,
      sourceAgnosticismResultSchema,
    ]) {
      const jsonSchema = z.toJSONSchema(schema)
      expect(jsonSchema).toBeTypeOf('object')
    }
  })

  it('evaluates source agnosticism across two source systems', () => {
    const leftFact = makeSampleClinicalFact({ sourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID })
    const rightFact = makeSampleClinicalFact({
      sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
      factId: 'fact-clinmesh-sim-lis-v2-2160-0-1',
      value: {
        rawText: '1.33 mg/dL',
        normalizedValue: { value: 1.33, unit: 'mg/dL' },
      },
    })

    const matched = evaluateSourceAgnosticismResult(
      { sourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID, facts: [leftFact] },
      { sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID, facts: [rightFact] },
    )
    expect(matched).toEqual({
      identicalNormalizedFacts: true,
      mismatches: [],
      sourceSystemsCompared: [PRIMARY_LOCAL_SOURCE_SYSTEM_ID, SIM_LIS_V2_SOURCE_SYSTEM_ID],
      comparedFactCount: 1,
    })

    const mismatchedValue = evaluateSourceAgnosticismResult(
      { sourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID, facts: [leftFact] },
      {
        sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
        facts: [
          makeSampleClinicalFact({
            sourceSystemId: SIM_LIS_V2_SOURCE_SYSTEM_ID,
            value: { rawText: '2.10 mg/dL', normalizedValue: { value: 2.1, unit: 'mg/dL' } },
          }),
        ],
      },
    )
    expect(mismatchedValue.identicalNormalizedFacts).toBe(false)
    expect(mismatchedValue.mismatches.length).toBeGreaterThan(0)

    const duplicateSource = evaluateSourceAgnosticismResult(
      { sourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID, facts: [leftFact] },
      { sourceSystemId: PRIMARY_LOCAL_SOURCE_SYSTEM_ID, facts: [leftFact] },
    )
    expect(duplicateSource.identicalNormalizedFacts).toBe(false)
  })
})
