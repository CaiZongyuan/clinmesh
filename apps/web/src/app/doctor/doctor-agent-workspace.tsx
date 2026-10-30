import { agentToolInputSchemas, doctorCaseSectionSchema } from '@clinmesh/contracts/agent'
import {
  doctorQueueViewStatusGroups
} from '@clinmesh/contracts/his'
import {
  newIdempotencyKey,
  previewStructuredClinicalDocumentSign
} from '../api-client.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import type { DoctorCaseModel } from './doctor-case-model.tsx'
import { doctorCaseSectionTabElementIds, doctorString, requireDoctorDetail, revisitDraftInputSchema, usesStructuredClinicalDocument } from './doctor-case-support.tsx'

type Context = Pick<DoctorCaseModel,
  | 'onQueueViewChange'
  | 'onSelectedCaseIdChange'
  | 'messages'
  | 'agentReview'
  | 'caseDetailRoot'
  | 'queue'
  | 'hydrateAgentDraft'
  | 'activeCaseId'
  | 'selectInvestigation'
  | 'imagingView'
  | 'detail'
  | 'completeCaseEncounter'
  | 'start'
  | 'beginRevisit'
  | 'saveDraft'
  | 'saveRevisit'
  | 'previewSign'
>

export function doctorWorkspaceAgentActions({
  onQueueViewChange,
  onSelectedCaseIdChange,
  messages,
  agentReview,
  caseDetailRoot,
  queue,
  hydrateAgentDraft,
  activeCaseId,
  selectInvestigation,
  imagingView,
  detail,
  completeCaseEncounter,
  start,
  beginRevisit,
  saveDraft,
  saveRevisit,
  previewSign,
}: Context) {
  return {
    'outpatient.case.read': {
      description: 'Read current case, queue.items (waiting + active; use each caseId to select a patient), imagingServices with availability, and pathologyServices with availability and the sourceProcedures that can be sent for slide consultation (each null when its catalog cannot be read).',
      enabled: activeCaseId !== undefined,
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: () => { throw new Error('Doctor reads require an authorized Query receipt') },
    },
    'outpatient.history.search': {
      enabled: activeCaseId !== undefined && detail.data !== undefined,
      description: 'Read one page of authorized local completed records or materialized Visible Source History for the current patient; reports source, time, coverage and missing materialization. Does not navigate.',
      parameters: {
        type: 'object' as const, properties: {
          source: { type: 'string', enum: ['local-completed', 'visible-source'] },
          page: { type: 'integer', minimum: 1 }, pageSize: { type: 'integer', minimum: 1, maximum: 20 },
        }, required: ['source'], additionalProperties: false
      },
      execute: () => { throw new Error('Doctor reads require an authorized Query receipt') },
    },
    'outpatient.history.read': {
      enabled: activeCaseId !== undefined && detail.data !== undefined,
      description: 'Read clinical details of one entry from the current patient authorized history index; use its source and entryId. Hidden simulation inputs, raw resources and pixels are excluded.',
      parameters: {
        type: 'object' as const, properties: {
          source: { type: 'string', enum: ['local-completed', 'visible-source'] }, entryId: { type: 'string', maxLength: 512 },
        }, required: ['source', 'entryId'], additionalProperties: false
      },
      execute: () => { throw new Error('Doctor reads require an authorized Query receipt') },
    },
    'outpatient.case.select': {
      description: 'Select caseId from loaded queue.items; switch to its waiting or active tab.',
      enabled: (queue.data?.items.length ?? 0) > 0,
      parameters: {
        type: 'object' as const,
        properties: { caseId: { type: 'string', maxLength: 128 } },
        required: ['caseId'],
        additionalProperties: false,
      },
      execute: (raw: unknown) => {
        const caseId = doctorString(raw, 'caseId', 128)
        const item = queue.data?.items.find(item => item.caseId === caseId)
        if (item === undefined) {
          throw new Error('Case is not in the current doctor queue')
        }
        onQueueViewChange(doctorQueueViewStatusGroups.waiting.includes(item.status) ? 'waiting' : 'active')
        onSelectedCaseIdChange(caseId)
        return { caseId, selected: true }
      },
    },
    'outpatient.section.select': {
      description: 'Select a case section; its Tools appear only while it is active (consultation; record; laboratory: lab/imaging/pathology requests, reports; diagnosis; prescription). imagingRequestId/pathologyRequestId (laboratory only) opens that study or slide for the human; no pixels.',
      enabled: detail.data !== undefined,
      parameters: {
        type: 'object' as const,
        properties: {
          imagingRequestId: { type: 'string', maxLength: 128 },
          pathologyRequestId: { type: 'string', maxLength: 128 },
          section: { type: 'string', enum: doctorCaseSectionSchema.options },
        },
        required: ['section'],
        additionalProperties: false,
      },
      execute: (raw: unknown) => {
        const { imagingRequestId, pathologyRequestId, section } = agentToolInputSchemas['outpatient.section.select'].parse(raw)
        if (
          imagingRequestId !== undefined
          && detail.data?.imagingRequests?.requests.find(item => item.id === imagingRequestId)?.report === undefined
        ) throw new Error('The imaging request has no report to open')
        if (
          pathologyRequestId !== undefined
          && detail.data?.pathologyRequests?.requests.find(item => item.id === pathologyRequestId)?.report === undefined
        ) throw new Error('The pathology consultation has no report to open')
        const tab = caseDetailRoot.current?.querySelector(`#${doctorCaseSectionTabElementIds[section]}`)
        if (!(tab instanceof HTMLButtonElement)) {
          throw new Error('Doctor case section is not available')
        }
        tab.click()
        if (imagingRequestId !== undefined) {
          selectInvestigation('imaging', imagingRequestId)
          imagingView.setOpen(imagingRequestId, true)
        }
        if (pathologyRequestId !== undefined) {
          selectInvestigation('pathology', pathologyRequestId)
          imagingView.setOpen(pathologyRequestId, true)
        }
        return {
          ...(imagingRequestId === undefined ? {} : { imagesOpened: pathologyRequestId === undefined, imagingRequestId }),
          ...(pathologyRequestId === undefined ? {} : { pathologyRequestId, slideOpened: true }),
          ...(imagingRequestId !== undefined && pathologyRequestId !== undefined ? { category: 'pathology' } : {}),
          section,
          selected: true,
        }
      },
    },
    'outpatient.first-visit.draft.set': {
      description: 'Validate and save the current first-visit draft without issuing an order.',
      enabled: detail.data?.status === 'first-visit' && !usesStructuredClinicalDocument(detail.data),
      parameters: {
        type: 'object' as const,
        properties: {
          assessment: { type: 'string', maxLength: 2000 },
          historyOfPresentIllness: { type: 'string', maxLength: 4000 },
        },
        required: ['assessment', 'historyOfPresentIllness'],
        additionalProperties: false,
      },
      execute: async (raw: unknown) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const result = await saveDraft.mutateAsync({
          assessment: doctorString(raw, 'assessment', 2000),
          caseId: current.caseId,
          historyOfPresentIllness: doctorString(raw, 'historyOfPresentIllness', 4000),
        })
        hydrateAgentDraft(current.caseId, 'first-visit')
        return result
      },
    },
    'outpatient.revisit.draft.set': {
      description: 'Validate and save the current revisit draft without signing it.',
      enabled: detail.data?.status === 'revisit-draft'
        && !usesStructuredClinicalDocument(detail.data),
      parameters: {
        type: 'object' as const,
        properties: {
          diagnosis: {
            type: 'object',
            properties: { code: { type: 'string' }, display: { type: 'string' } },
            required: ['code', 'display'],
            additionalProperties: false,
          },
          document: {
            type: 'object',
            properties: { assessment: { type: 'string' }, plan: { type: 'string' } },
            required: ['assessment', 'plan'],
            additionalProperties: false,
          },
          medications: {
            type: 'array',
            minItems: 1,
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                catalogItemId: { type: 'string' },
                doseText: { type: 'string' },
                frequencyCode: { type: 'string' },
                quantity: { type: 'integer' },
              },
              required: ['catalogItemId', 'doseText', 'frequencyCode', 'quantity'],
              additionalProperties: false,
            },
          },
        },
        required: ['diagnosis', 'document', 'medications'],
        additionalProperties: false,
      },
      execute: async (raw: unknown) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const result = await saveRevisit.mutateAsync({
          caseId: current.caseId,
          ...revisitDraftInputSchema.parse(raw),
        })
        hydrateAgentDraft(current.caseId, 'revisit')
        return result
      },
    },
    'outpatient.preview.request': {
      description: 'Generate the current clinical sign preview without committing it.',
      enabled: usesStructuredClinicalDocument(detail.data)
        ? detail.data?.clinicalDocument?.draft !== undefined
        : detail.data?.drafts?.document !== undefined,
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: () => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        if (!usesStructuredClinicalDocument(current)) {
          return previewSign.mutateAsync({ caseId: current.caseId })
        }
        const draft = current.clinicalDocument?.draft
        if (draft === undefined) throw new Error(messages.consultationUnavailable)
        return previewStructuredClinicalDocumentSign({
          encounterId: current.encounter.id,
          encounterVersion: current.encounter.versionId,
          expectedDraftVersion: draft.version,
        }, newIdempotencyKey())
      },
    },
    'outpatient.visit.start.propose': {
      description: 'Open human review before starting the selected visit.',
      enabled: detail.data?.status === 'awaiting-doctor'
        || detail.data?.status === 'awaiting-revisit',
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: (_raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const revisit = current.status === 'awaiting-revisit'
        return agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale)[revisit ? 'startRevisit' : 'startFirstVisit'],
          description: current.patient.name,
          onConfirm: () => revisit
            ? beginRevisit.mutateAsync({ caseId: current.caseId })
            : start.mutateAsync({ caseId: current.caseId }),
          signal,
          title: locale => getWorkspaceMessages(locale)[revisit ? 'startRevisit' : 'startFirstVisit'],
        })
      },
    },
    'outpatient.encounter.complete.propose': {
      description: 'Open human review before completing the selected Encounter.',
      enabled: detail.data?.encounter.status === 'in-progress',
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: (_raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        return agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale).encounterCompleted,
          description: current.patient.name,
          onConfirm: () => completeCaseEncounter.mutateAsync({ caseId: current.caseId }),
          signal,
          title: locale => getWorkspaceMessages(locale).encounterCompleted,
        })
      },
    }
  }
}
