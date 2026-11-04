import {
  prescriptionDraftContentSchema
} from '@clinmesh/contracts/his'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import type { DoctorCaseModel } from './doctor-case-model.tsx'
import { requireDoctorDetail } from './doctor-case-support.tsx'

type Context = Pick<DoctorCaseModel,
  | 'messages'
  | 'agentReview'
  | 'hydrateAgentDraft'
  | 'detail'
  | 'savePrescription'
  | 'issueCasePrescription'
  | 'confirmCaseNoMedication'
  | 'withdrawCasePrescription'
>

export function doctorPrescriptionAgentActions({
  messages,
  agentReview,
  hydrateAgentDraft,
  detail,
  savePrescription,
  issueCasePrescription,
  confirmCaseNoMedication,
  withdrawCasePrescription,
}: Context) {
  return {
    'outpatient.prescription.draft.set': {
      description: 'Validate and save the controlled prescription draft without issuing it.',
      enabled: detail.data?.consultation !== undefined
        && detail.data.medicationConclusion?.prescription === undefined
        && detail.data.medicationConclusion?.noMedication === undefined,
      parameters: {
        type: 'object' as const,
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                catalogItemId: { type: 'string' },
                courseDays: { type: 'integer', minimum: 1, maximum: 30 },
                doseText: { type: 'string', maxLength: 120 },
                frequencyCode: { type: 'string', maxLength: 32 },
                quantity: { type: 'integer', minimum: 1, maximum: 1_000 },
              },
              required: [
                'catalogItemId', 'courseDays', 'doseText', 'frequencyCode', 'quantity',
              ],
              additionalProperties: false,
            },
          },
        },
        required: ['items'],
        additionalProperties: false,
      },
      execute: async (raw: unknown) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const input = prescriptionDraftContentSchema.parse(raw)
        const result = await savePrescription.mutateAsync({
          caseId: current.caseId,
          items: input.items,
        })
        hydrateAgentDraft(current.caseId, 'prescription')
        return result
      },
    },
    'outpatient.prescription.issue.propose': {
      description: 'Open human review before issuing the current prescription draft.',
      enabled: detail.data?.medicationConclusion?.draft !== undefined,
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: (_raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const state = current.medicationConclusion
        if (state?.draft === undefined) throw new Error(messages.consultationUnavailable)
        const itemCount = state.draft.items.length
        return agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale).issuePrescription,
          description: locale => `${current.patient.name} · ${itemCount} ${locale === 'zh-CN' ? '项药品' : 'medication items'}`,
          onConfirm: () => issueCasePrescription.mutateAsync({ caseId: current.caseId }),
          signal,
          title: locale => getWorkspaceMessages(locale).issuePrescription,
        })
      },
    },
    'outpatient.prescription.withdraw.propose': {
      description: 'Open human review before withdrawing the current undispensed prescription.',
      enabled: detail.data?.medicationConclusion?.prescription?.status === 'signed'
        || detail.data?.medicationConclusion?.prescription?.status === 'paid',
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: (_raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const prescription = current.medicationConclusion?.prescription
        if (
          prescription === undefined
          || (prescription.status !== 'signed' && prescription.status !== 'paid')
        ) throw new Error(messages.consultationUnavailable)
        return agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale).confirmWithdrawal,
          description: prescription.number,
          onConfirm: () => withdrawCasePrescription.mutateAsync({
            caseId: current.caseId,
            prescriptionId: prescription.id,
          }),
          signal,
          title: locale => getWorkspaceMessages(locale).withdrawPrescriptionTitle,
        })
      },
    },
    'outpatient.medication.none.propose': {
      description: 'Open human review before recording a formal no-medication conclusion.',
      enabled: detail.data?.consultation !== undefined
        && detail.data.medicationConclusion?.prescription === undefined
        && detail.data.medicationConclusion?.noMedication === undefined,
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: (_raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const state = current.medicationConclusion
        if (state?.prescription !== undefined || state?.noMedication !== undefined) {
          throw new Error(messages.consultationUnavailable)
        }
        return agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale).confirmNoMedication,
          description: current.patient.name,
          onConfirm: () => confirmCaseNoMedication.mutateAsync({ caseId: current.caseId }),
          signal,
          title: locale => getWorkspaceMessages(locale).confirmNoMedication,
        })
      },
    }
  }
}
