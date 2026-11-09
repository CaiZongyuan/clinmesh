import {
  diagnosisDraftEntrySchema, type SessionContext
} from '@clinmesh/contracts/his'
import {
  ApiClientError,
  confirmDoctorPreparation,
  getSession,
  newIdempotencyKey,
} from '../api-client.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import type { DoctorCaseModel } from './doctor-case-model.tsx'
import { doctorDiagnosisEntries, requireDoctorDetail } from './doctor-case-support.tsx'
import { clearDiagnosisPrivateDraftForHydration } from './diagnosis-draft-storage.ts'
import { hasStoredInvestigationConfirmation, prepareInvestigationConfirmationIntent, saveInvestigationConfirmationIntent } from './investigation-draft-storage.ts'
import { doctorPreparationItemIdentity } from './doctor-preparation-identity.ts'

type Context = Pick<DoctorCaseModel,
  | 'messages'
  | 'agentReview'
  | 'hydrateAgentDraft'
  | 'pageScope'
  | 'pageScopeRef'
  | 'mountedRef'
  | 'session'
  | 'catalog'
  | 'locale'
  | 'detail'
  | 'refreshCaseById'
  | 'saveCaseDiagnosis'
>

export function doctorDiagnosisAgentActions({
  messages,
  agentReview,
  hydrateAgentDraft,
  pageScope,
  pageScopeRef,
  mountedRef,
  session,
  catalog,
  locale,
  detail,
  refreshCaseById,
  saveCaseDiagnosis,
}: Context) {
  const draftScope = detail.data === undefined ? undefined : JSON.stringify([pageScope, detail.data.caseId, detail.data.encounter.id, 'diagnosis'])
  return {
    'outpatient.diagnosis.draft.set': {
      description: 'Validate and save the structured diagnosis draft without confirming it.',
      enabled: detail.data?.consultation !== undefined
        && detail.data.encounter.status === 'in-progress'
        && draftScope !== undefined && !hasStoredInvestigationConfirmation(draftScope),
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
        const scope = JSON.stringify([pageScope, current.caseId, current.encounter.id, 'diagnosis'])
        if (hasStoredInvestigationConfirmation(scope)) throw new Error(messages.inpatientIntentPendingDescription)
        const result = await saveCaseDiagnosis.mutateAsync({
          caseId: current.caseId,
          entries,
        })
        if (hasStoredInvestigationConfirmation(scope)) throw new Error(messages.inpatientIntentPendingDescription)
        clearDiagnosisPrivateDraftForHydration(scope)
        hydrateAgentDraft(current.caseId, 'diagnosis')
        return result
      },
    },
    'outpatient.diagnosis.confirm.propose': {
      description: 'Open human review before confirming structured diagnoses.',
      enabled: detail.data?.consultation !== undefined
        && detail.data.encounter.status === 'in-progress'
        && draftScope !== undefined && !hasStoredInvestigationConfirmation(draftScope),
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
        const scope = JSON.stringify([pageScope, current.caseId, current.encounter.id, 'diagnosis'])
        const ownsContext = () => mountedRef.current && pageScopeRef.current === pageScope && !signal.aborted
        const requireContext = () => {
          if (!ownsContext()) throw new Error(messages.consultationUnavailable)
          if (hasStoredInvestigationConfirmation(scope)) throw new Error(messages.inpatientIntentPendingDescription)
        }
        requireContext()
        return agentReview.request({
          anchor: `doctor-diagnosis:${current.caseId}`,
          confirmLabel: locale => getWorkspaceMessages(locale).confirmDiagnosis,
          description: locale => locale === 'zh-CN' ? `${entries.length} 项诊断` : `${entries.length} diagnoses`,
          onConfirm: async () => {
            requireContext()
            const fresh = await getSession()
            requireContext()
            const binding = (value: SessionContext) => JSON.stringify([value.user.id, value.actor.actorId, value.actor.epoch,
              value.actor.workspaceId, value.actor.scenarioRunId, value.actor.practitionerRoleId, value.actor.roleCode,
              value.actor.practitionerId, value.actor.organizationId, value.actor.locationId])
            if (binding(fresh) !== binding(session)) throw new Error(messages.consultationUnavailable)
            const selections = entries.map(entry => ({ ...entry, kind: 'diagnosis' as const, source: 'manual' as const }))
            const frozen = prepareInvestigationConfirmationIntent({
              state: { caseId: current.caseId, kind: 'diagnosis', encounterId: current.encounter.id, encounterVersion: current.encounter.versionId },
              selections, draftVersion: current.diagnosis?.draftVersion ?? 0, resolveExistingDraft: current.diagnosis?.draft !== undefined,
              key: newIdempotencyKey(), rows: selections.map(selection => ({ key: doctorPreparationItemIdentity(selection),
                label: selection.referenceConcept?.display
                  ?? catalog.data?.diagnoses.find(entry => entry.id === selection.catalogItemId)?.[locale === 'zh-CN' ? 'nameZh' : 'nameEn']
                  ?? selection.catalogItemId, signature: JSON.stringify(selection) })),
            })
            if (!saveInvestigationConfirmationIntent(scope, frozen)) throw new Error(messages.inpatientIntentPendingDescription)
            try {
              const result = await confirmDoctorPreparation(frozen.state, frozen.draftVersion, frozen.selections, frozen.key, frozen.resolveExistingDraft)
              if (ownsContext()) saveInvestigationConfirmationIntent(scope, { ...frozen, result }, frozen.key)
              return result
            } catch (error) {
              if (ownsContext() && error instanceof ApiClientError && error.status === 409 && ['WORKFLOW_CONFLICT', 'CATALOG_CONFLICT'].includes(error.code)) {
                saveInvestigationConfirmationIntent(scope, null, frozen.key)
              }
              throw error
            } finally { await refreshCaseById(current.caseId) }
          },
          signal,
          title: locale => getWorkspaceMessages(locale).confirmDiagnosis,
        })
      },
    }
  }
}
