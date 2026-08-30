import {
  patientBriefContentSchema,
  patientBriefRevisionSchema,
} from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'

const content = {
  chiefComplaint: '反复头晕一周',
  knownHistorySummary: '既往有高血压病史，规律服药。',
  openingStatement: '医生您好，我这周总是头晕，想来看看。',
  symptomTopics: [{
    answerPoints: ['一周前开始。', '起身时更明显。'],
    id: 'dizziness-onset',
    name: '头晕经过',
  }],
}

describe('Patient Brief contracts', () => {
  it('accepts a bounded structured Brief with unique stable topic IDs', () => {
    expect(patientBriefContentSchema.parse(content)).toEqual(content)
    expect(patientBriefRevisionSchema.parse({
      caseId: 'synthetic-case-001',
      content,
      createdAt: '2026-08-30T08:00:00+08:00',
      inputHash: 'a'.repeat(64),
      model: 'fake-brief-model',
      outputHash: 'b'.repeat(64),
      promptHash: 'c'.repeat(64),
      promptVersion: 'patient-brief-v1',
      revision: 1,
      workspaceId: 'workspace-demo',
    }).content).toEqual(content)
  })

  it('rejects duplicate topic IDs and unknown output fields', () => {
    expect(patientBriefContentSchema.safeParse({
      ...content,
      diagnosis: '高血压',
      symptomTopics: [content.symptomTopics[0], content.symptomTopics[0]],
    }).success).toBe(false)
  })
})
