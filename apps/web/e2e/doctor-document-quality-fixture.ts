import { z } from 'zod'
import { clinicalDocumentDraftContentSchema, clinicalDocumentQualityEvidenceSchema } from '@clinmesh/contracts/his'
import type { JsonChatCompletionInput } from '../../server/src/infrastructure/ai/openai-chat-completions.ts'

export const qualityPatientReply = '我对青霉素过敏。今天上午量体温38.5℃。'

// Synthetic semantics exercise UI wiring; source identity and persistence stay real.
export function documentQualityFixture(input: Pick<JsonChatCompletionInput, 'schemaName' | 'userPayload'>): unknown {
  if (input.schemaName === 'clinical_document_quality_verification') {
    const payload = z.object({ issues: z.array(z.unknown()), agentFacts: z.array(z.object({ id: z.string() })) }).parse(input.userPayload)
    return { issues: payload.issues.map((_, index) => ({ index, supported: true })),
      agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: false })) }
  }
  if (input.schemaName !== 'clinical_document_quality') throw new Error(`Unexpected quality schema: ${input.schemaName}`)
  const payload = z.object({
    document: clinicalDocumentDraftContentSchema,
    evidence: z.array(clinicalDocumentQualityEvidenceSchema),
    agentFacts: z.array(z.object({ id: z.string() })),
  }).parse(input.userPayload)
  const source = payload.evidence.find(item => item.kind === 'patient' && item.text.includes(qualityPatientReply))
  const sourceQuotes = source === undefined ? [] : [{ evidenceId: source.id, quote: qualityPatientReply }]
  const issues = []
  if (payload.document.chiefComplaint === '头晕。') issues.push({ kind: 'missing-field', field: 'chiefComplaint',
    explanation: { impact: '主诉未说明头晕持续多久，阅读者不能直接了解症状时间范围。',
      suggestion: '核对现病史中的已知持续时间后补录主诉；时间不能确认可如实注明不详。' },
    message: '主诉尚未记录持续时间，请结合已知病史补充。', documentQuote: '头晕。', sourceQuotes: [] })
  if (source !== undefined && !payload.document.allergyHistory?.includes('青霉素')) issues.push({
    explanation: { impact: '过敏史正文未保留患者已陈述的青霉素过敏信息，阅读者可能遗漏该自述。',
      suggestion: '核对患者原回答后补录过敏史，保留患者自述限定；不推定其他药物过敏情况。' },
    kind: 'omission', field: 'allergyHistory', message: '患者已说明青霉素过敏，过敏史中尚未记录，请核实后补充。', sourceQuotes,
  })
  if (source !== undefined && payload.document.physicalExamination === '今天上午体温36.5℃。') issues.push({
    explanation: { impact: '正文与患者回答记录了同日上午不同的体温数值，测量时点尚未核对。',
      suggestion: '对照原文核实两次测量的时间和来源，再修订相应表述；不直接将自述或查体判错。' },
    kind: 'inconsistency', field: 'physicalExamination', message: '同日上午体温与患者回答不一致，请核实测量时间及原文。',
    documentQuote: '今天上午体温36.5℃。', sourceQuotes,
  })
  return { issues, agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: false })) }
}
