import {
  clinicalDocumentFieldSchema
} from '@clinmesh/contracts/his'
import {
  cancelStructuredClinicalDocumentSign,
  newIdempotencyKey,
  previewStructuredClinicalDocumentSign,
  saveClinicalDocumentDraft,
  signClinicalDocument,
  signStructuredClinicalDocument
} from '../api-client.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import {
  ClinicalDocumentContentView
} from './clinical-document-page.tsx'
import type { DoctorCaseModel } from './doctor-case-model.tsx'
import { clinicalDocumentRevisionInputSchema, doctorClinicalDocument, requireDoctorDetail, usesStructuredClinicalDocument } from './doctor-case-support.tsx'
import { DocumentQualitySignSummary } from './document-quality-control.tsx'

type Context = Pick<DoctorCaseModel,
  | 'messages'
  | 'agentReview'
  | 'setWorkingClinicalDocuments'
  | 'hydrateAgentDraft'
  | 'pageScopeRef'
  | 'mountedRef'
  | 'detail'
  | 'refreshCaseById'
  | 'applySignCancellation'
  | 'signingDependencies'
  | 'reviseClinicalDocument'
  | 'previewSign'
>

export function doctorRecordAgentActions({
  messages,
  agentReview,
  setWorkingClinicalDocuments,
  hydrateAgentDraft,
  pageScopeRef,
  mountedRef,
  detail,
  refreshCaseById,
  applySignCancellation,
  signingDependencies,
  reviseClinicalDocument,
  previewSign,
}: Context) {
  return {
    'outpatient.record.draft.set': {
      description: 'Validate and save the structured clinical document draft without signing it.',
      enabled: usesStructuredClinicalDocument(detail.data)
        && detail.data?.encounter.status === 'in-progress',
      parameters: {
        type: 'object' as const,
        properties: {
          ...Object.fromEntries([
            'allergyHistory', 'familyHistory', 'assessment', 'auxiliaryExamination', 'chiefComplaint', 'disposition',
            'followUp', 'historyOfPresentIllness', 'physicalExamination', 'priorMedicalHistory',
          ].map(key => [key, { type: 'string', maxLength: 4000 }])),
          agentFacts: {
            type: 'array', maxItems: 64, items: {
              type: 'object', additionalProperties: false,
              properties: {
                field: { type: 'string', enum: clinicalDocumentFieldSchema.options },
                text: { type: 'string', minLength: 1, maxLength: 5000 },
                sources: {
                  type: 'array', maxItems: 12, items: {
                    type: 'object', additionalProperties: false,
                    properties: {
                      sourceTurnId: { type: 'string', minLength: 1, maxLength: 128 },
                      quote: { type: 'string', minLength: 2, maxLength: 2000 }
                    }, required: ['sourceTurnId', 'quote']
                  }
                }
              },
              required: ['field', 'text', 'sources']
            }
          },
        },
        required: [
          'assessment', 'auxiliaryExamination', 'chiefComplaint', 'disposition',
          'followUp', 'historyOfPresentIllness', 'physicalExamination', 'priorMedicalHistory',
        ],
        additionalProperties: false,
      },
      execute: async (raw: unknown) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const { document, agentFacts } = doctorClinicalDocument(raw)
        const result = await saveClinicalDocumentDraft({
          agentGenerated: true,
          ...(agentFacts === undefined ? {} : { agentFacts }),
          document,
          encounterId: current.encounter.id,
          encounterVersion: current.encounter.versionId,
          expectedDraftVersion: current.clinicalDocument?.draft?.version ?? 0,
        }, newIdempotencyKey())
        await refreshCaseById(current.caseId)
        setWorkingClinicalDocuments(documents => ({
          ...documents,
          [current.caseId]: document,
        }))
        hydrateAgentDraft(current.caseId, 'record')
        return result
      },
    },
    'outpatient.record.sign.propose': {
      description: 'Generate a sign preview and open human review before signing clinical facts.',
      enabled: usesStructuredClinicalDocument(detail.data)
        ? detail.data?.clinicalDocument?.draft !== undefined
        : detail.data?.drafts?.document !== undefined,
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: async (_raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        if (usesStructuredClinicalDocument(current)) {
          const proposalScope = pageScopeRef.current
          signal.throwIfAborted()
          const draft = current.clinicalDocument?.draft
          if (draft === undefined) throw new Error(messages.consultationUnavailable)
          const preview = await previewStructuredClinicalDocumentSign({
            encounterId: current.encounter.id,
            encounterVersion: current.encounter.versionId,
            expectedDraftVersion: draft.version,
          }, newIdempotencyKey())
          const cancel = async () => {
            try {
              const cancelled = await cancelStructuredClinicalDocumentSign({
                encounterId: current.encounter.id,
                encounterVersion: current.encounter.versionId, previewId: preview.data.previewId
              }, newIdempotencyKey())
              await applySignCancellation(current.caseId, cancelled.data.previewId)
            } finally { await refreshCaseById(current.caseId) }
          }
          try {
            signal.throwIfAborted()
            if (!mountedRef.current || pageScopeRef.current !== proposalScope) throw new Error(messages.consultationUnavailable)
            const task = agentReview.request({
              content: locale => {
                const reviewMessages = getWorkspaceMessages(locale)
                return <div className="flex flex-col gap-3">
                  <DocumentQualitySignSummary detail={current} state={preview.data.qualityControl} scope={proposalScope} locale={locale} />
                  <ClinicalDocumentContentView content={preview.data.document.content} messages={reviewMessages} />
                </div>
              },
              confirmLabel: locale => getWorkspaceMessages(locale).confirmClinicalRecordSign,
              description: current.patient.name,
              onConfirm: () => signStructuredClinicalDocument({
                commitToken: preview.data.commitToken,
                encounterId: current.encounter.id,
                encounterVersion: current.encounter.versionId,
                previewId: preview.data.previewId,
              }, newIdempotencyKey()).then(async result => {
                await refreshCaseById(current.caseId)
                return result
              }),
              signal,
              title: locale => getWorkspaceMessages(locale).confirmClinicalRecordSign,
            })
            void refreshCaseById(current.caseId)
            return {
              ...task, decision: task.decision.then(async result => {
                if (!result.approved) await cancel()
                return result
              }, async error => {
                await cancel().catch(() => undefined)
                throw error
              })
            }
          } catch (error) {
            await cancel().catch(() => undefined)
            throw error
          }
        }
        const preview = await previewSign.mutateAsync({ caseId: current.caseId })
        const dependencies = signingDependencies(current.caseId)
        return agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale).confirmClinicalSign,
          description: locale => detail.data?.patient.name ?? getWorkspaceMessages(locale).consultationUnavailable,
          onConfirm: () => signClinicalDocument({
            commitToken: preview.data.commitToken,
            encounterId: dependencies.encounterId,
            expectedVersions: dependencies.expectedVersions,
            previewId: preview.data.previewId,
          }, newIdempotencyKey()).then(async result => {
            await refreshCaseById(current.caseId)
            return result
          }),
          signal,
          title: locale => getWorkspaceMessages(locale).confirmClinicalSign,
        })
      },
    },
    'outpatient.record.revise.propose': {
      description: 'Open human review before creating a revision of the latest signed document.',
      enabled: (detail.data?.clinicalDocument?.signed.length ?? 0) > 0,
      parameters: {
        type: 'object' as const,
        properties: {
          document: {
            type: 'object',
            properties: Object.fromEntries([
              'allergyHistory', 'familyHistory', 'assessment', 'auxiliaryExamination', 'chiefComplaint', 'disposition',
              'followUp', 'historyOfPresentIllness', 'physicalExamination', 'priorMedicalHistory',
            ].map(key => [key, { type: 'string' }])),
            required: [
              'assessment', 'auxiliaryExamination', 'chiefComplaint', 'disposition',
              'followUp', 'historyOfPresentIllness', 'physicalExamination', 'priorMedicalHistory',
            ],
            additionalProperties: false,
          },
          reason: { type: 'string', maxLength: 500 },
        },
        required: ['document', 'reason'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const latest = current.clinicalDocument?.signed.at(-1)
        if (latest === undefined) throw new Error(messages.consultationUnavailable)
        const input = clinicalDocumentRevisionInputSchema.parse(raw)
        return agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale).confirmClinicalDocumentRevisionAction,
          description: `${current.patient.name} · ${input.reason}`,
          onConfirm: () => reviseClinicalDocument.mutateAsync({
            caseId: current.caseId,
            compositionId: latest.compositionId,
            compositionVersion: latest.compositionVersion,
            document: input.document,
            encounterId: current.encounter.id,
            encounterVersion: current.encounter.versionId,
            reason: input.reason,
          }),
          signal,
          title: locale => getWorkspaceMessages(locale).confirmClinicalDocumentRevision,
        })
      },
    }
  }
}
