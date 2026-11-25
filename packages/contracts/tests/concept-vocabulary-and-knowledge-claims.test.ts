import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  conceptMappingEligibilitySchema,
  conceptMappingSchema,
  conceptNodeSchema,
  conceptVocabularyCatalogResponseSchema,
  conceptVocabularySchema,
} from '../src/concept-vocabulary.ts'
import {
  SIMULATION_TRIAL_DISCLAIMER_ZH,
  clinicalReviewerRecordSchema,
  diseasePackKnowledgeEvaluationSchema,
  knowledgeClaimSchema,
  knowledgeSnapshotSchema,
  knowledgeTopicCardSchema,
} from '../src/knowledge-claims.ts'

describe('concept-vocabulary and knowledge-claims contracts', () => {
  it('enforces reviewerId when concept mapping reviewStatus is reviewed or approved', () => {
    expect(() => conceptMappingSchema.parse({
      effectiveDate: '2026-01-01',
      id: 'map-1',
      relation: 'exact',
      reviewStatus: 'approved',
      reviewerId: null,
      sourceCode: 'SYN-01',
      sourceDisplay: '合成项目',
      sourceSystem: 'urn:clinmesh:test',
      targetConceptCode: '2160-0',
      version: '1.0.0',
    })).toThrow()

    expect(() => conceptMappingSchema.parse({
      effectiveDate: '2026-01-01',
      id: 'map-2',
      relation: 'close',
      reviewStatus: 'reviewed',
      reviewerId: null,
      sourceCode: 'SYN-02',
      sourceDisplay: '合成项目2',
      sourceSystem: 'urn:clinmesh:test',
      targetConceptCode: '89579-7',
      version: '1.0.0',
    })).toThrow()

    const proposed = conceptMappingSchema.parse({
      effectiveDate: '2026-01-01',
      id: 'map-3',
      relation: 'exact',
      reviewStatus: 'proposed',
      reviewerId: null,
      sourceCode: 'SYN-03',
      sourceDisplay: '合成项目3',
      sourceSystem: 'urn:clinmesh:test',
      targetConceptCode: '2160-0',
      version: '1.0.0',
    })
    expect(proposed.reviewerId).toBeNull()
  })

  it('rejects extra unknown keys on strict concept and knowledge schemas', () => {
    expect(() => conceptNodeSchema.parse({
      code: '2160-0',
      displayZh: '血清肌酐',
      domain: 'laboratory',
      extraField: 'not-allowed',
      layer: 'public',
      parentCode: null,
    })).toThrow()

    expect(() => clinicalReviewerRecordSchema.parse({
      licenseVerified: false,
      nameZh: '张医生',
      reviewerId: 'rev-1',
      specialty: 'cardiology',
    })).toThrow()

    expect(() => knowledgeTopicCardSchema.parse({
      effectiveFrom: '2026-06-01T00:00:00Z',
      id: 'topic-1',
      limitationsZh: ['仅限仿真测试'],
      navigationZh: '操作性导航',
      packId: 'synthetic-test-syndrome',
      references: [{
        page: 1,
        quoteFragment: 'test quote',
        sha256: 'a'.repeat(64),
        sourceId: 'src-1',
        title: '测试指南',
        version: '2026',
      }],
      status: 'auto-verified',
      titleZh: '标题',
      unexpected: true,
      version: '1.0.0',
    })).toThrow()
  })

  it('exposes exact simulation trial disclaimer constant and JSON-schema-compatible definitions', () => {
    expect(SIMULATION_TRIAL_DISCLAIMER_ZH).toBe('未经医生检查，仅用于仿真')
    expect(() => z.toJSONSchema(conceptVocabularySchema)).not.toThrow()
    expect(() => z.toJSONSchema(conceptMappingEligibilitySchema)).not.toThrow()
    expect(() => z.toJSONSchema(conceptVocabularyCatalogResponseSchema)).not.toThrow()
    expect(() => z.toJSONSchema(knowledgeClaimSchema)).not.toThrow()
    expect(() => z.toJSONSchema(knowledgeSnapshotSchema)).not.toThrow()
    expect(() => z.toJSONSchema(diseasePackKnowledgeEvaluationSchema)).not.toThrow()
  })
})
