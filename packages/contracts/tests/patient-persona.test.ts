import {
  patientBriefLegacyContentSchema,
  patientPersonaContentSchema,
  patientPersonaRevisionSchema,
} from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'

const legacyContent = {
  chiefComplaint: '反复头晕一周',
  knownHistorySummary: '既往有高血压病史，规律服药。',
  openingStatement: '医生您好，我这周总是头晕，想来看看。',
  symptomTopics: [{
    answerPoints: ['一周前开始。', '起身时更明显。'],
    id: 'dizziness-onset',
    name: '头晕经过',
  }],
}

const content = {
  chiefComplaint: '反复头晕一周',
  knownHistorySummary: '既往有高血压病史，规律服药。',
  medicationMemory: '每天吃一片降压药，名字记不清。',
  openingStatement: '医生您好，我这周总是头晕，想来看看。',
  persona: {
    attitude: '怕花钱，能不查就不查',
    character: '直爽、话多',
    healthLiteracy: '小学文化，听不懂医学名词',
    speechStyle: '句子短，爱打比方',
  },
  symptomExperience: '一周前蹲下起身时开始晕，眼前发黑，歇一会儿能缓过来，没自己买过药。',
}

describe('Patient Persona contracts', () => {
  it('accepts a bounded structured persona with traits and symptom experience', () => {
    expect(patientPersonaContentSchema.parse(content)).toEqual(content)
    expect(patientPersonaRevisionSchema.parse({
      caseId: 'synthetic-case-001',
      content,
      createdAt: '2026-08-30T08:00:00+08:00',
      inputHash: 'a'.repeat(64),
      model: 'fake-persona-model',
      outputHash: 'b'.repeat(64),
      promptHash: 'c'.repeat(64),
      promptVersion: 'patient-persona-v1',
      revision: 1,
      workspaceId: 'workspace-demo',
    }).content).toEqual(content)
  })

  it('keeps reading legacy Patient Brief revisions with question topics', () => {
    expect(patientPersonaRevisionSchema.parse({
      caseId: 'synthetic-case-001',
      content: legacyContent,
      createdAt: '2026-08-30T08:00:00+08:00',
      inputHash: 'a'.repeat(64),
      model: 'fake-brief-model',
      outputHash: 'b'.repeat(64),
      promptHash: 'c'.repeat(64),
      promptVersion: 'patient-brief-v1',
      revision: 1,
      workspaceId: 'workspace-demo',
    }).content).toEqual(legacyContent)
    expect(patientBriefLegacyContentSchema.safeParse({
      ...legacyContent,
      symptomTopics: [legacyContent.symptomTopics[0], legacyContent.symptomTopics[0]],
    }).success).toBe(false)
  })

  it('rejects unknown output fields', () => {
    expect(patientPersonaContentSchema.safeParse({
      ...content,
      diagnosis: '高血压',
    }).success).toBe(false)
  })
})
