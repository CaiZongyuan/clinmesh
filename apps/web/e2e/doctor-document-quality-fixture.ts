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
    message: '主诉尚未记录持续时间，请结合已知病史补充。', documentQuote: '头晕。', sourceQuotes: [] })
  if (source !== undefined && !payload.document.priorMedicalHistory?.includes('青霉素')) issues.push({
    kind: 'omission', field: 'priorMedicalHistory', message: '患者已说明青霉素过敏，既往史中尚未记录，请核实后补充。', sourceQuotes,
  })
  if (source !== undefined && payload.document.physicalExamination === '今天上午体温36.5℃。') issues.push({
    kind: 'inconsistency', field: 'physicalExamination', message: '同日上午体温与患者回答不一致，请核实测量时间及原文。',
    documentQuote: '今天上午体温36.5℃。', sourceQuotes,
  })
  return { issues, agentFactChecks: payload.agentFacts.map(fact => ({ id: fact.id, supported: false })) }
}
