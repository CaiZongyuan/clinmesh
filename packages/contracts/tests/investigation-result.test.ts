import {
  investigationResultContentSchema,
  investigationResultSnapshotSchema,
} from '@clinmesh/contracts/scenario'
import { describe, expect, it } from 'vitest'

describe('Investigation Result Snapshot contract', () => {
  it('freezes exactly one requested structured result with provenance', () => {
    expect(investigationResultSnapshotSchema.parse({
      caseId: 'synthetic-case-001',
      catalogItemId: 'laboratory:body-temperature',
      content: {
        conclusion: '体温升高。',
        results: [{
          code: '8310-5',
          display: '体温',
          interpretation: 'high',
          referenceRange: { high: 37.3, low: 36, text: '36.0-37.3 Cel' },
          unit: { code: 'Cel', display: 'Cel', system: 'http://unitsofmeasure.org' },
          value: 38.2,
        }],
      },
      createdAt: '2026-08-30T08:00:00+08:00',
      inputHash: 'a'.repeat(64),
      model: 'fake-investigation-model',
      outputHash: 'b'.repeat(64),
      promptHash: 'c'.repeat(64),
      promptVersion: 'investigation-result-v1',
      requestedConcept: {
        code: '8310-5',
        display: '体温',
        id: 'laboratory:body-temperature',
        laboratory: {
          category: 'vital-sign',
          referenceRange: { high: 37.3, low: 36, text: '36.0-37.3 Cel' },
          resultType: 'quantity',
          specimen: 'body',
          unit: { code: 'Cel', display: 'Cel', system: 'http://unitsofmeasure.org' },
        },
        sourceLocator: 'synthetic[0]',
        system: 'http://loinc.org',
        version: '2.83',
      },
      snapshotId: 'investigation-snapshot-001',
      source: 'investigation-agent',
      workspaceId: 'workspace-demo',
    }).content.results).toHaveLength(1)
  })

  it('rejects a quantitative result without numeric reference boundaries', () => {
    expect(() => investigationResultContentSchema.parse({
      conclusion: '白细胞计数在正常范围内。',
      results: [{
        code: '6690-2',
        display: '白细胞计数',
        interpretation: 'normal',
        referenceRange: { text: '未配置参考范围' },
        unit: { code: '10*9/L', display: '10*9/L', system: 'http://unitsofmeasure.org' },
        value: 7.5,
      }],
    })).toThrow('A quantitative Investigation result requires a numeric reference boundary')
  })
})
