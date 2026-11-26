import { describe, expect, it } from 'vitest'
import {
  phenotypeKnowledgeBaseSchema,
  phenotypeMatchResultSchema,
  phenotypeObservationRuleSchema,
} from '../src/phenotype-matcher.ts'

describe('phenotype-matcher contracts', () => {
  it('rejects fact matchers without conceptCodes, codePatterns, or textPattern and rejects minValue > maxValue', () => {
    const emptyMatcher = phenotypeObservationRuleSchema.safeParse({
      domain: 'lipid',
      labelEn: 'Empty',
      labelZh: '空规则',
      matcher: {
        categories: ['laboratory'],
      },
      phenotypeCode: 'PHENO-EMPTY',
    })
    expect(emptyMatcher.success).toBe(false)

    const invertedRange = phenotypeObservationRuleSchema.safeParse({
      domain: 'lipid',
      labelEn: 'Inverted',
      labelZh: '区间倒置',
      matcher: {
        conceptCodes: ['13457-7'],
        maxValue: 3.0,
        minValue: 5.0,
      },
      phenotypeCode: 'PHENO-INVERTED',
    })
    expect(invertedRange.success).toBe(false)
  })

  it('rejects duplicate phenotypeCodes and dangling candidate term references in KB schema', () => {
    const duplicateRules = phenotypeKnowledgeBaseSchema.safeParse({
      version: '1.0.0',
      phenotypeRules: [
        {
          domain: 'lipid',
          labelEn: 'LDL high',
          labelZh: '高LDL',
          matcher: { conceptCodes: ['13457-7'], minValue: 4.9 },
          phenotypeCode: 'PHENO-A',
        },
        {
          domain: 'lipid',
          labelEn: 'LDL duplicate',
          labelZh: '重复LDL',
          matcher: { conceptCodes: ['13457-7'], minValue: 5.5 },
          phenotypeCode: 'PHENO-A',
        },
      ],
      candidates: [
        {
          diseaseId: 'test-disease',
          minMatchedTerms: 1,
          minScoreThreshold: 0.5,
          recommendedWorkupZh: ['复查血脂'],
          referralSuggestionZh: '转诊专病门诊',
          specialty: 'cardiology',
          titleEn: 'Test Disease',
          titleZh: '测试疾病',
          weightedTerms: [
            { phenotypeCode: 'PHENO-UNKNOWN', rationaleZh: '未定义规则', weight: 0.6 },
          ],
        },
      ],
    })
    expect(duplicateRules.success).toBe(false)
    if (!duplicateRules.success) {
      const messages = duplicateRules.error.issues.map(i => i.message).join(' | ')
      expect(messages).toContain('Duplicate phenotypeCode')
      expect(messages).toContain('PHENO-UNKNOWN')
    }
  })

  it('enforces llmInvocationCount === 0 on PhenotypeMatchResult', () => {
    const baseResult = {
      candidates: [],
      eligibleFactCount: 0,
      evaluatedAsOf: '2026-08-24T10:00:00+08:00',
      excludedFactSummary: {
        conflictCount: 0,
        externalUnverifiedCount: 0,
        notAskedOrErrorCount: 0,
        supersededCount: 0,
        suspiciousCount: 0,
      },
      knowledgeBaseVersion: '2026-11-26.r1',
      llmInvocationCount: 0,
      matchedPhenotypeTerms: [],
      promptCards: [],
    }
    expect(phenotypeMatchResultSchema.parse(baseResult).llmInvocationCount).toBe(0)
    expect(phenotypeMatchResultSchema.safeParse({ ...baseResult, llmInvocationCount: 1 }).success).toBe(false)
  })
})
