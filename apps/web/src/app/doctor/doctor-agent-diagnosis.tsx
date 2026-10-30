import {
  diagnosisDraftEntrySchema
} from '@clinmesh/contracts/his'
import {
  confirmDiagnosis,
  newIdempotencyKey,
  saveDiagnosisDraft
} from '../api-client.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import type { DoctorCaseModel } from './doctor-case-model.tsx'
import { doctorDiagnosisEntries, requireDoctorDetail } from './doctor-case-support.tsx'

type Context = Pick<DoctorCaseModel,
  | 'messages'
  | 'agentReview'
  | 'hydrateAgentDraft'
  | 'detail'
  | 'refreshCaseById'
  | 'saveCaseDiagnosis'
>

export function doctorDiagnosisAgentActions({
  messages,
  agentReview,
  hydrateAgentDraft,
  detail,
  refreshCaseById,
  saveCaseDiagnosis,
}: Context) {
  return {
    'outpatient.diagnosis.draft.set': {
      description: 'Validate and save the structured diagnosis draft without confirming it.',
      enabled: detail.data?.consultation !== undefined
        && detail.data.encounter.status === 'in-progress',
      parameters: {
        type: 'object' as const,
        properties: {
          entries: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                catalogItemId: { type: 'string' },
                note: { type: 'string', maxLength: 500 },
                role: { type: 'string', enum: diagnosisDraftEntrySchema.shape.role.options },
              },
              required: ['catalogItemId', 'role'],
              additionalProperties: false,
            },
          },
        },
        required: ['entries'],
        additionalProperties: false,
      },
      execute: async (raw: unknown) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const entries = doctorDiagnosisEntries(raw)
        const result = await saveCaseDiagnosis.mutateAsync({
          caseId: current.caseId,
          entries,
        })
        hydrateAgentDraft(current.caseId, 'diagnosis')
        return result
      },
    },
    'outpatient.diagnosis.confirm.propose': {
      description: 'Open human review before confirming structured diagnoses.',
      enabled: detail.data?.consultation !== undefined
        && detail.data.encounter.status === 'in-progress',
      parameters: {
        type: 'object' as const,
        properties: {
          entries: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                catalogItemId: { type: 'string' },
                note: { type: 'string', maxLength: 500 },
                role: { type: 'string', enum: diagnosisDraftEntrySchema.shape.role.options },
              },
              required: ['catalogItemId', 'role'],
              additionalProperties: false,
            },
          },
        },
        required: ['entries'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const entries = doctorDiagnosisEntries(raw)
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        return agentReview.request({
          anchor: `doctor-diagnosis:${current.caseId}`,
          confirmLabel: locale => getWorkspaceMessages(locale).confirmDiagnosis,
          description: locale => locale === 'zh-CN' ? `${entries.length} 项诊断` : `${entries.length} diagnoses`,
          onConfirm: async () => {
            const saved = await saveDiagnosisDraft({
              encounterId: current.encounter.id,
              encounterVersion: current.encounter.versionId,
              entries,
              expectedDraftVersion: current.diagnosis?.draftVersion ?? 0,
            }, newIdempotencyKey())
            const result = await confirmDiagnosis({
              encounterId: current.encounter.id,
              encounterVersion: current.encounter.versionId,
              expectedDraftVersion: saved.data.draftVersion,
            }, newIdempotencyKey())
            await refreshCaseById(current.caseId)
            return result
          },
          signal,
          title: locale => getWorkspaceMessages(locale).confirmDiagnosis,
        })
      },
    }
  }
}
