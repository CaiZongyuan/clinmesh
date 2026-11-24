import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  CLINICAL_FACT_CATEGORIES,
  clinicalFactLedgerSchema,
  clinicalFactSchema,
  clinicalFactVerificationResponseSchema,
  DEFAULT_CLINICAL_FACT_HOSPITAL_ID,
  DEFAULT_CLINICAL_FACT_MAPPING_VERSION,
  inpatientClinicalFactLedgerQuerySchema,
  inpatientClinicalFactVerificationInputSchema,
  KNOWN_CLINICAL_FACT_SOURCE_SYSTEMS,
  outpatientClinicalFactLedgerQuerySchema,
  outpatientClinicalFactVerificationInputSchema,
} from '../src/clinical-fact-ledger.ts'

describe('clinical-fact-ledger contracts', () => {
  it('accepts a valid ClinicalFact across all 14 mandatory fields and verification envelope', () => {
    const sampleFact = {
      factId: 'fact:clinmesh-his-fhir:Observation:obs-1:1',
      category: 'laboratory',
      itemCode: {
        code: '89579-7',
        system: 'http://loinc.org',
        display: '高敏肌钙蛋白I (hs-cTnI)',
      },
      value: {
        rawText: '45.2 ng/L',
        normalizedValue: { value: 45.2, unit: 'ng/L' },
      },
      method: 'hs-cTnI',
      specimenOrSite: {
        label: '静脉血',
        specimenId: 'spec-1',
      },
      orderedAt: '2026-08-24T08:00:00+08:00',
      effectiveAt: '2026-08-24T08:30:00+08:00',
      reportedAt: '2026-08-24T09:00:00+08:00',
      provenance: {
        recordType: 'Observation',
        recordId: 'obs-1',
        recordVersion: '1',
        sourceSystemId: 'clinmesh-his-fhir',
      },
      institutionScope: 'local',
      recordStatus: 'final',
      presence: 'present',
      relation: {
        supersedesFactId: null,
        supersededByFactId: null,
      },
      verificationStatus: 'not-applicable',
      ingestedAt: '2026-08-24T09:00:00+08:00',
      mappingVersion: DEFAULT_CLINICAL_FACT_MAPPING_VERSION,
      qualityFlags: [],
      suspiciousReasons: [],
      conflictingFactIds: [],
      requiresRecheckPrompt: false,
      validityDays: 90,
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
    }

    const parsed = clinicalFactSchema.parse(sampleFact)
    expect(parsed.factId).toBe(sampleFact.factId)

    const ledger = clinicalFactLedgerSchema.parse({
      trace: {
        hospitalId: DEFAULT_CLINICAL_FACT_HOSPITAL_ID,
        evaluatedAsOf: '2026-08-24T10:00:00+08:00',
        mappingVersion: DEFAULT_CLINICAL_FACT_MAPPING_VERSION,
      },
      patientId: 'pat-1',
      subjectKind: 'outpatient',
      subjectId: 'case-1',
      includeSuperseded: false,
      facts: [parsed],
      summary: {
        totalFacts: 1,
        eligibleCount: 1,
        suspiciousCount: 0,
        conflictCount: 0,
        externalUnverifiedCount: 0,
        verifiedExternalCount: 0,
        expiredCount: 0,
        supersededCount: 0,
        notAskedCount: 0,
      },
    })
    expect(ledger.facts).toHaveLength(1)
  })

  it('covers all 8 categories and reserved source system ids', () => {
    expect(CLINICAL_FACT_CATEGORIES).toEqual([
      'diagnosis',
      'allergy',
      'laboratory',
      'examination',
      'vital-sign',
      'medication',
      'procedure',
      'bedside-questionnaire',
    ])
    expect(KNOWN_CLINICAL_FACT_SOURCE_SYSTEMS).toEqual([
      'clinmesh-his-fhir',
      'clinmesh-visible-source-history',
      'clinmesh-bedside-questionnaire',
    ])
  })

  it('produces JSON Schemas cleanly for CLI and OpenAPI compatibility', () => {
    expect(() => z.toJSONSchema(outpatientClinicalFactLedgerQuerySchema)).not.toThrow()
    expect(() => z.toJSONSchema(inpatientClinicalFactLedgerQuerySchema)).not.toThrow()
    expect(() => z.toJSONSchema(outpatientClinicalFactVerificationInputSchema)).not.toThrow()
    expect(() => z.toJSONSchema(inpatientClinicalFactVerificationInputSchema)).not.toThrow()
    expect(() => z.toJSONSchema(clinicalFactLedgerSchema)).not.toThrow()
    expect(() => z.toJSONSchema(clinicalFactVerificationResponseSchema)).not.toThrow()
  })

  it('rejects unknown keys and invalid categories strictly', () => {
    expect(() => clinicalFactSchema.parse({
      factId: 'f1',
      category: 'unknown-category',
    })).toThrow()

    expect(() => outpatientClinicalFactVerificationInputSchema.parse({
      caseId: 'case-1',
      factId: 'fact-1',
      extra: 'forbidden',
    })).toThrow()
  })
})
