import {
  syntheticCaseInstanceSchema,
  syntheticSourceHistoryGroupSchema,
  syntheticSourceHistoryGroupListSchema,
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

  it('groups visible source-history events by business date', () => {
    const group = {
      businessDate: '2025-01-10',
      items: [{
        clinicalDate: '2025-01-10T09:00:00+08:00',
        resourceType: 'Condition',
        sourceReference: 'urn:uuid:prior-condition',
        title: '高血压（疾病）',
      }],
    }

    expect(syntheticSourceHistoryGroupSchema.parse(group)).toEqual(group)
  })

  it('paginates visible source history as business-date groups', () => {
    const response = {
      items: [{
        businessDate: '2025-01-10',
        items: [{
          clinicalDate: '2025-01-10T09:00:00+08:00',
          resourceType: 'Condition',
          sourceReference: 'urn:uuid:prior-condition',
          title: '高血压（疾病）',
        }],
      }],
      page: 1,
      pageSize: 20,
      total: 1,
    }

    expect(syntheticSourceHistoryGroupListSchema.parse(response)).toEqual(response)
  })

  it('rejects empty or cross-date source-history groups', () => {
    expect(syntheticSourceHistoryGroupSchema.safeParse({
      businessDate: '2025-01-10',
      items: [],
    }).success).toBe(false)
    expect(syntheticSourceHistoryGroupSchema.safeParse({
      businessDate: '2025-01-09',
      items: [{
        clinicalDate: '2025-01-09T17:30:00Z',
        resourceType: 'Condition',
        sourceReference: 'urn:uuid:prior-condition',
        title: '高血压（疾病）',
      }],
    }).success).toBe(false)
  })
})
