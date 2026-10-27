import { expect, it } from 'vitest'
import { guidelineCorpusStatistics, isGuidelineSourceUsable, type GuidelineSourceStatus } from '../src/application/guideline-corpus.ts'
import { syntheticGuidelineDocument } from './fixtures/guideline-corpus.ts'

it.each(['withdrawn', 'superseded'] as const)('副本标记为%s不反向停用原指南或其他副本', status => {
  const parent = syntheticGuidelineDocument.source
  const child = { ...parent, id: 'local-evaluation-hospital-upload', derivedFromSourceId: parent.id, status }
  const sibling = { ...parent, id: 'local-evaluation-another-upload', derivedFromSourceId: parent.id }
  const policy = { allowLocalEvaluation: true, knownSources: [parent, child, sibling] }
  expect(isGuidelineSourceUsable(parent, false, policy)).toBe(true)
  expect(isGuidelineSourceUsable(child, false, policy)).toBe(false)
  expect(isGuidelineSourceUsable(sibling, false, policy)).toBe(true)
})

it('指定来源的统计保留包外父链限制，共享正文不重复累计段落', () => {
  const parent = structuredClone(syntheticGuidelineDocument.source)
  parent.status = 'withdrawn'
  const child = { ...parent, id: 'local-evaluation-upload', status: 'active' as const, derivedFromSourceId: parent.id }
  const independent = { ...parent, id: 'independent', status: 'active' as const, sha256: 'b'.repeat(64) }
  const sources: GuidelineSourceStatus[] = [
    { source: parent, bodyId: 'shared-body', passageCount: 2 },
    { source: child, bodyId: 'shared-body', passageCount: 2 },
    { source: independent, bodyId: 'independent-body', passageCount: 1 },
  ]
  expect(guidelineCorpusStatistics(sources, { allowLocalEvaluation: true, sourceIds: [child.id] }))
    .toEqual({ sourceCount: 1, documentCount: 1, passageCount: 2, unusablePassageCount: 0,
      searchableSourceCount: 0, searchableDocumentCount: 0, searchablePassageCount: 0 })
  parent.status = 'active'
  expect(guidelineCorpusStatistics(sources, { allowLocalEvaluation: true }))
    .toEqual({ sourceCount: 3, documentCount: 2, passageCount: 3, unusablePassageCount: 0,
      searchableSourceCount: 3, searchableDocumentCount: 2, searchablePassageCount: 3 })
})

it('完整性不可信的原来源及其派生内容均不计入可用覆盖', () => {
  const parent = syntheticGuidelineDocument.source
  const child = { ...parent, id: 'local-evaluation-upload', derivedFromSourceId: parent.id }
  expect(guidelineCorpusStatistics([
    { source: parent, bodyId: 'shared-body', passageCount: 1, integrityValid: false },
    { source: child, bodyId: 'shared-body', passageCount: 1 },
  ], { allowLocalEvaluation: true })).toMatchObject({ sourceCount: 2, documentCount: 1, passageCount: 1,
    searchableSourceCount: 0, searchableDocumentCount: 0, searchablePassageCount: 0 })
})
