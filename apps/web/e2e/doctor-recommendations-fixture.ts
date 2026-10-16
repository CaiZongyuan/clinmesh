import { z } from 'zod'
import { join } from 'node:path'
import {
  doctorCaseEvidenceSchema, doctorRecommendationConsiderationSchema, doctorRecommendationKindSchema, doctorRecommendationSuggestionSchema,
  guidelineEvidenceSchema,
} from '@clinmesh/contracts/doctor-recommendations'
import type { JsonChatCompletionInput } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'
import { syntheticGuidelineDocument, syntheticGuidelineMarker } from '../../server/tests/fixtures/guideline-corpus.ts'
import { GuidelineCorpus } from '../../server/src/infrastructure/sqlite/guideline-corpus.ts'

export const recommendationReasoningMarker = '合成待核实评估：患者近一周反复头晕；头晕与体位的关系尚未明确。'
export const recommendationProcessingMarker = '合成处理说明验收：本轮不输出任何候选或思路。'

export function createRecommendationGuidelineDatabase(directory: string): string {
  const databasePath = join(directory, 'guidelines.sqlite')
  const corpus = new GuidelineCorpus({ databasePath })
  try { corpus.importDocument(syntheticGuidelineDocument) }
  finally { corpus.close() }
  return databasePath
}

// The external model is synthetic; the server still owns evidence, catalogs, verification and persistence.
export function recommendationFixture(input: Pick<JsonChatCompletionInput, 'schemaName' | 'userPayload'>): unknown {
  if (input.schemaName === 'doctor_recommendation_catalog_selection') {
    const payload = z.object({ catalogs: z.object({ laboratory: z.object({ items: z.array(z.object({
      id: z.string(), nameZh: z.string(),
    })) }) }) }).parse(input.userPayload)
    return { complete: true, selectedCatalogItemIds: payload.catalogs.laboratory.items
      .filter(item => item.nameZh === '合成白细胞计数').map(item => item.id) }
  }
  if (input.schemaName === 'doctor_recommendation_history_selection') {
    const payload = z.object({ historyEvidence: z.array(doctorCaseEvidenceSchema) }).parse(input.userPayload)
    return { complete: true, selectedEvidenceIds: payload.historyEvidence.map(item => item.id) }
  }
  if (input.schemaName === 'doctor_recommendation_verification') {
    const payload = z.object({ items: z.array(doctorRecommendationSuggestionSchema),
      considerations: z.array(doctorRecommendationConsiderationSchema).optional(),
      guidelines: z.array(guidelineEvidenceSchema), caseEvidence: z.array(doctorCaseEvidenceSchema),
    }).parse(input.userPayload)
    const entries = [...payload.items, ...payload.considerations ?? []]
    for (const item of entries) {
      if (item.caseEvidenceIds.some(id => !payload.caseEvidence.some(evidence => evidence.id === id))) {
        throw new Error('Synthetic verification requires actual case evidence')
      }
    }
    if (payload.items.some(item => item.guidelineEvidenceIds.some(id => !payload.guidelines.some(evidence => evidence.id === id)))) {
      throw new Error('Synthetic verification requires actual guideline evidence')
    }
    return { items: entries.map(item => ({ id: item.id,
      guidelineSupported: 'kind' in item && !item.id.endsWith('-downgraded'), caseSupported: true,
      applicable: true, qualifiersPreserved: !item.id.endsWith('-rejected'),
      ...(item.id.endsWith('-rejected') ? { reason: '原文仅记录体位关系未明确，不能改写为已排除。' }
        : item.id.endsWith('-downgraded') ? { reason: '所引指南条款未支持本项合成判断。' } : {}),
      ...('kind' in item && item.kind === 'prescription' ? { prescriptionFields: {
        doseText: true, frequencyCode: true, courseDays: false, quantity: false,
      } } : {}),
    })) }
  }
  const payload = z.object({
    kind: doctorRecommendationKindSchema, guidelines: z.array(guidelineEvidenceSchema),
    caseEvidence: z.array(doctorCaseEvidenceSchema),
    catalogs: z.object({
      laboratory: z.object({ items: z.array(z.object({
        id: z.string(), nameZh: z.string(), allowedIndicationCodes: z.array(z.string()),
      })) }).optional(),
      diagnoses: z.object({ local: z.array(z.object({ id: z.string(), code: z.string(), nameZh: z.string() })) }).optional(),
      medications: z.array(z.object({ id: z.string(), nameZh: z.string() })).optional(),
    }),
  }).parse(input.userPayload)
  if (payload.caseEvidence.some(item => item.text.includes(recommendationProcessingMarker))) {
    return { items: [], considerations: [], missingInformation: [] }
  }
  const reasoningEvidence = payload.caseEvidence.find(item => item.text === recommendationReasoningMarker)
  if (reasoningEvidence !== undefined && (payload.kind === 'diagnosis' || payload.kind === 'laboratory')) {
    const clause = payload.guidelines.find(item => item.id === (payload.kind === 'diagnosis'
      ? 'ws-t-872-2025-treatment' : 'ws-t-872-2025-initial-assessment'))
    if (clause === undefined) throw new Error('Synthetic reasoning fixture requires the baseline hypertension clause')
    const reasoning = {
      id: `synthetic-case-reasoning-${payload.kind}`, label: '合成体位相关头晕的评估思路',
      rationale: '当前记录反复头晕，可先核实与体位变化的关系，不能据此确诊。',
      supportingInformation: ['现病史记录近一周反复头晕。'],
      opposingInformation: ['尚未记录头晕与体位变化的明确联系，不能据此确诊。'],
      missingInformation: ['询问起立时是否加重，以决定是否进行卧立位血压评估。'], caseEvidenceIds: [reasoningEvidence.id],
    }
    const diagnosis = payload.catalogs.diagnoses?.local.find(item => item.code === 'I10')
    const laboratory = payload.catalogs.laboratory?.items.find(item => item.nameZh === '合成白细胞计数')
    const candidate = payload.kind === 'diagnosis'
      ? { kind: payload.kind, catalogItemId: diagnosis?.id }
      : { kind: payload.kind, catalogItemId: laboratory?.id, indicationCode: laboratory?.allowedIndicationCodes[0] }
    if (candidate.catalogItemId === undefined) throw new Error('Synthetic reasoning fixture requires a matching baseline catalog item')
    return { items: [
      { ...reasoning, ...candidate, id: `${reasoning.id}-downgraded`, guidelineEvidenceIds: [clause.id] },
      { ...reasoning, ...candidate, id: `${reasoning.id}-catalog`, label: '合成未开展的目录候选',
        catalogItemId: 'synthetic-unavailable-catalog', guidelineEvidenceIds: [clause.id] },
    ], considerations: [reasoning, { ...reasoning, id: `${reasoning.id}-rejected`, label: '合成被核验拦截的确定性结论',
      rationale: '合成患者已证实排除体位性头晕。' }], missingInformation: [] }
  }
  const importedEvidence = payload.caseEvidence.find(item => item.text.includes(syntheticGuidelineMarker))
  if (payload.kind === 'diagnosis' && importedEvidence !== undefined) {
    const clause = payload.guidelines.find(item => item.title === syntheticGuidelineDocument.source.title
      && item.sourceHash === syntheticGuidelineDocument.source.sha256)
    if (clause === undefined) return { items: [], missingInformation: ['未收到已导入的合成糖尿病指南。'] }
    const diagnosis = payload.catalogs.diagnoses?.local.find(item => item.code === 'E11.65')
    if (diagnosis === undefined) throw new Error('Synthetic baseline must provide E11.65')
    return { items: [{ id: 'synthetic-imported-diabetes', label: '合成导入糖尿病建议', kind: 'diagnosis',
      catalogItemId: diagnosis.id, rationale: '合成新增主题仅供核对导入指南，不自动确诊。',
      supportingInformation: ['医生已补充合成糖尿病病史。'], opposingInformation: [], missingInformation: ['仍需核对本次血糖。'],
      guidelineEvidenceIds: [clause.id], caseEvidenceIds: [importedEvidence.id] }], missingInformation: [] }
  }
  const evidence = payload.caseEvidence.find(item => item.text.includes('高血压'))
  const clauseId = payload.kind === 'prescription' ? 'viatris-norvasc-adult-hypertension-dose'
    : payload.kind === 'laboratory' ? 'ws-t-872-2025-initial-assessment' : 'ws-t-872-2025-treatment'
  const clause = payload.guidelines.find(item => item.id === clauseId)
  if (evidence === undefined || clause === undefined) return { items: [], missingInformation: ['缺少合成病例建议的对应依据。'] }
  const common = { id: `synthetic-${payload.kind}-recommendation`, label: '合成建议',
    rationale: '合成建议：结合可见高血压资料，由医生核对适用条件。', supportingInformation: ['当前可见高血压病史。'],
    opposingInformation: [], missingInformation: ['核对既有治疗和个体适用条件。'],
    guidelineEvidenceIds: [clause.id], caseEvidenceIds: [evidence.id] }
  if (payload.kind === 'laboratory') {
    const service = payload.catalogs.laboratory?.items.find(item => item.nameZh === '合成白细胞计数')
    if (service === undefined) return { items: [], missingInformation: ['当前医院没有相符的合成检验项目。'] }
    return { items: [{ ...common, kind: 'laboratory', catalogItemId: service.id,
      indicationCode: service.allowedIndicationCodes[0] }], missingInformation: [] }
  }
  if (payload.kind === 'diagnosis') {
    const diagnosis = payload.catalogs.diagnoses?.local.find(item => item.code === 'I10')
    if (diagnosis === undefined) throw new Error('Synthetic baseline must provide I10')
    return { items: [{ ...common, kind: 'diagnosis', catalogItemId: diagnosis.id }], missingInformation: [] }
  }
  if (payload.kind === 'prescription') {
    const medication = payload.catalogs.medications?.find(item => item.id === 'medication-amlodipine')
    if (medication === undefined) throw new Error('Synthetic baseline must provide amlodipine')
    // Deliberately unsupported course and quantity must be removed by independent verification.
    return { items: [{ ...common, kind: 'prescription', catalogItemId: medication.id,
      doseText: '5 mg', frequencyCode: 'QD', courseDays: 30, quantity: 30 }], missingInformation: [] }
  }
  return { items: [], missingInformation: ['当前合成病例没有相符的检查依据。'] }
}
