import {
  syntheticCaseInstanceSchema,
  syntheticCaseRegistrationListSchema,
  syntheticSourceHistoryItemSchema,
} from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'

const caseInstance = {
  activeBriefRevision: null,
  caseId: 'synthetic-case-001',
  caseType: 'follow-up',
  createdAt: '2026-08-30T08:00:00.000+08:00',
  profileId: 'synthetic-patient-profile-001',
  profileRevision: 1,
  revision: 1,
  sourceHash: 'a'.repeat(64),
  status: 'brief-pending',
  updatedAt: '2026-08-30T08:00:00.000+08:00',
  visibleHistoryCount: 2,
  workspaceId: 'workspace-001',
}

describe('Synthetic Case contracts', () => {
  it('exposes visible case metadata without accepting Case Truth references', () => {
    expect(syntheticCaseInstanceSchema.parse(caseInstance)).toEqual(caseInstance)
    expect(() => syntheticCaseInstanceSchema.parse({
      ...caseInstance,
      hiddenResourceReferences: ['urn:uuid:index-condition'],
      indexEncounterReference: 'urn:uuid:index-encounter',
    })).toThrow()
  })

  it('describes one visible source-history event without claiming local care', () => {
    expect(syntheticSourceHistoryItemSchema.parse({
      clinicalDate: '2025-01-10T09:00:00+08:00',
      resourceType: 'Condition',
      sourceReference: 'urn:uuid:prior-condition',
      title: '高血压（疾病）',
    })).toEqual({
      clinicalDate: '2025-01-10T09:00:00+08:00',
      resourceType: 'Condition',
      sourceReference: 'urn:uuid:prior-condition',
      title: '高血压（疾病）',
    })
  })

  it('exposes only the fixed case and identity fields needed for registration', () => {
    const list = {
      items: [{
        activeBriefRevision: 2,
        birthDate: '1970-01-01',
        caseId: 'synthetic-case-001',
        caseRevision: 3,
        caseType: 'follow-up',
        gender: 'female',
        mrn: 'MRN-000001',
        name: '张琴',
        profileRevision: 1,
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    }

    expect(syntheticCaseRegistrationListSchema.parse(list)).toEqual(list)
    expect(() => syntheticCaseRegistrationListSchema.parse({
      ...list,
      items: [{
        ...list.items[0],
        source: { raw: { resourceType: 'Bundle' } },
      }],
    })).toThrow()
  })
})
