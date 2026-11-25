import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  SYNTHETIC_TEST_GUIDELINE_DISCLAIMER_ZH,
  SYNTHETIC_TEST_GUIDELINE_MARKER,
  adjudicateConflictInputSchema,
  adjudicateConflictRequestSchema,
  adjudicateConflictResultSchema,
  conceptMappingImpactReportSchema,
  conceptMappingImpactRequestSchema,
  draftedKnowledgeClaimCandidateSchema,
  guidelineDiffImpactItemSchema,
  guidelineDiffReportRequestSchema,
  guidelineSearchExpandedTermSchema,
  guidelineSourceDiffReportSchema,
  offlineGuidelineSearchRequestSchema,
  offlineGuidelineSearchResponseSchema,
  offlineKnowledgePipelineInputSchema,
  offlineKnowledgePipelineResultSchema,
  structuralCheckRejectionSchema,
  syntheticTestGuidelineDocSchema,
} from '../src/knowledge-pipeline.ts'

describe('knowledge-pipeline contracts', () => {
  it('enforces synthetic test marker and disclaimer on syntheticTestGuidelineDocSchema', () => {
    expect(() => syntheticTestGuidelineDocSchema.parse({
      disclaimerZh: '真实临床指南正文',
      passages: [{ locator: '第1页', page: 1, text: '测试段落。' }],
      sha256: 'a'.repeat(64),
      sourceId: 'syn-guide-1',
      syntheticTestMarker: SYNTHETIC_TEST_GUIDELINE_MARKER,
      title: '测试指南',
      version: '1.0.0',
    })).toThrow()

    expect(() => syntheticTestGuidelineDocSchema.parse({
      disclaimerZh: SYNTHETIC_TEST_GUIDELINE_DISCLAIMER_ZH,
      passages: [{ locator: '第1页', page: 1, text: '测试段落。' }],
      sha256: 'a'.repeat(64),
      sourceId: 'syn-guide-1',
      syntheticTestMarker: 'OFFICIAL_CLINICAL_GUIDELINE',
      title: '测试指南',
      version: '1.0.0',
    })).toThrow()

    const valid = syntheticTestGuidelineDocSchema.parse({
      disclaimerZh: SYNTHETIC_TEST_GUIDELINE_DISCLAIMER_ZH,
      passages: [{ locator: '第1页', page: 1, text: '测试段落。' }],
      sha256: 'a'.repeat(64),
      sourceId: 'syn-guide-1',
      syntheticTestMarker: SYNTHETIC_TEST_GUIDELINE_MARKER,
      title: '合成测试指南',
      version: '1.0.0',
    })
    expect(valid.syntheticTestMarker).toBe('SYNTHETIC_TEST_GUIDELINE_NOT_CLINICAL')
  })

  it('rejects unverified reviewer or unknown fields on strict schemas', () => {
    expect(() => adjudicateConflictInputSchema.parse({
      conflictId: 'c1',
      decision: 'adopt-new',
      rationaleZh: '同意采纳',
      reviewer: {
        licenseVerified: false,
        nameZh: '李医生',
        reviewerId: 'rev-1',
        specialty: 'cardiology',
      },
    })).toThrow()

    expect(() => guidelineSearchExpandedTermSchema.parse({
      conceptCode: 'myocardial-infarction',
      expandedTerm: '心肌梗死',
      extra: 'not-allowed',
      queryTerm: '心梗',
    })).toThrow()
  })

  it('produces JSON schemas cleanly for all knowledge-pipeline contracts', () => {
    const schemas = [
      draftedKnowledgeClaimCandidateSchema,
      structuralCheckRejectionSchema,
      offlineKnowledgePipelineInputSchema,
      offlineKnowledgePipelineResultSchema,
      guidelineDiffImpactItemSchema,
      guidelineSourceDiffReportSchema,
      adjudicateConflictInputSchema,
      guidelineDiffReportRequestSchema,
      adjudicateConflictRequestSchema,
      adjudicateConflictResultSchema,
      conceptMappingImpactReportSchema,
      conceptMappingImpactRequestSchema,
      guidelineSearchExpandedTermSchema,
      offlineGuidelineSearchRequestSchema,
      offlineGuidelineSearchResponseSchema,
    ]
    for (const schema of schemas) {
      expect(() => z.toJSONSchema(schema, { unrepresentable: 'any' })).not.toThrow()
    }
    expect(() => z.toJSONSchema(guidelineSearchExpandedTermSchema)).not.toThrow()
    expect(() => z.toJSONSchema(offlineKnowledgePipelineResultSchema)).not.toThrow()
    expect(() => z.toJSONSchema(conceptMappingImpactReportSchema)).not.toThrow()
  })
})
