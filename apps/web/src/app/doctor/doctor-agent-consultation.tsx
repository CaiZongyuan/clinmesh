import type { DoctorCaseModel } from './doctor-case-model.tsx'
import { doctorString, requireDoctorDetail } from './doctor-case-support.tsx'

type Context = Pick<DoctorCaseModel,
  | 'messages'
  | 'detail'
  | 'askQuestion'
  | 'retryPatientReply'
>

export function doctorConsultationAgentActions({
  messages,
  detail,
  askQuestion,
  retryPatientReply,
}: Context) {
  return {
    'outpatient.consultation.ask': {
      description: 'Send a free-text message to the patient in the current consultation.',
      enabled: detail.data?.consultation !== undefined
        && detail.data.encounter.status !== 'completed'
        && detail.data.consultation.turns.findLast(turn => turn.kind === 'text')?.speaker !== 'doctor'
        && !askQuestion.isPending
        && !retryPatientReply.isPending,
      parameters: {
        type: 'object' as const,
        properties: { message: { type: 'string', minLength: 1, maxLength: 2000 } },
        required: ['message'],
        additionalProperties: false,
      },
      execute: (raw: unknown) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        return askQuestion.mutateAsync({
          caseId: current.caseId,
          message: doctorString(raw, 'message', 2000),
        })
      },
    },
    'outpatient.consultation.reply.retry': {
      description: 'Retry the patient reply to the last unanswered doctor message.',
      enabled: detail.data?.encounter.status !== 'completed'
        && detail.data?.consultation?.turns.findLast(turn => turn.kind === 'text')?.speaker === 'doctor'
        && !askQuestion.isPending && !retryPatientReply.isPending,
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: () => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        return retryPatientReply.mutateAsync({ caseId: current.caseId })
      },
    }
  }
}
