import { agentToolInputSchemas } from '@clinmesh/contracts/agent'
import {
  acknowledgeImagingReport,
  acknowledgePathologyReport,
  cancelImagingRequest,
  cancelPathologyRequest,
  correctImagingReport,
  correctPathologyReport,
  issueImagingRequest,
  issuePathologyRequest,
  newIdempotencyKey,
  retryImagingRequest,
  retryPathologyRequest,
  saveImagingRequestDraft,
  saveLaboratoryRequestDraft,
  savePathologyRequestDraft
} from '../api-client.ts'
import { getWorkspaceMessages } from '../workspace-i18n.ts'
import type { DoctorCaseModel } from './doctor-case-model.tsx'
import { doctorString, isCancellableLaboratoryRequest, isQuantitativeLaboratoryResult, reportCorrectionInputSchema, requireDoctorDetail } from './doctor-case-support.tsx'

type Context = Pick<DoctorCaseModel,
  | 'messages'
  | 'agentReview'
  | 'setLaboratoryItemId'
  | 'setIndicationCode'
  | 'hydrateAgentDraft'
  | 'activeCaseId'
  | 'activeCaseIdRef'
  | 'selectInvestigation'
  | 'imagingView'
  | 'detail'
  | 'usesIndependentLaboratoryRequests'
  | 'resolvedLaboratoryItemId'
  | 'resolvedLaboratoryItem'
  | 'resolvedIndicationCode'
  | 'refreshCaseById'
  | 'issueOrder'
  | 'saveLaboratoryRequest'
  | 'issueRequest'
  | 'cancelRequest'
  | 'acknowledgeReport'
  | 'correctReport'
  | 'canCorrectReports'
  | 'runImagingAction'
>

export function doctorInvestigationsAgentActions({
  messages,
  agentReview,
  setLaboratoryItemId,
  setIndicationCode,
  hydrateAgentDraft,
  activeCaseId,
  activeCaseIdRef,
  selectInvestigation,
  imagingView,
  detail,
  usesIndependentLaboratoryRequests,
  resolvedLaboratoryItemId,
  resolvedLaboratoryItem,
  resolvedIndicationCode,
  refreshCaseById,
  issueOrder,
  saveLaboratoryRequest,
  issueRequest,
  cancelRequest,
  acknowledgeReport,
  correctReport,
  canCorrectReports,
  runImagingAction,
}: Context) {
  return {
    'outpatient.laboratory.draft.set': {
      description: 'Validate and save a laboratory request draft without issuing it.',
      enabled: detail.data?.consultation !== undefined
        && detail.data.encounter.status === 'in-progress',
      parameters: {
        type: 'object' as const,
        properties: {
          catalogItemId: { type: 'string', maxLength: 512 },
          indicationCode: { type: 'string', maxLength: 64 },
        },
        required: ['catalogItemId', 'indicationCode'],
        additionalProperties: false,
      },
      execute: async (raw: unknown) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const {
          catalogItemId,
          indicationCode: nextIndication,
        } = agentToolInputSchemas['outpatient.laboratory.draft.set'].parse(raw)
        const result = await saveLaboratoryRequestDraft({
          catalogItemId,
          encounterId: current.encounter.id,
          encounterVersion: current.encounter.versionId,
          expectedDraftVersion: current.laboratoryRequests?.draftVersion ?? 0,
          indicationCode: nextIndication,
        }, newIdempotencyKey())
        await refreshCaseById(current.caseId)
        hydrateAgentDraft(current.caseId, 'laboratory')
        if (activeCaseIdRef.current === current.caseId) {
          setLaboratoryItemId(catalogItemId)
          setIndicationCode(nextIndication)
          selectInvestigation('laboratory')
        }
        return result
      },
    },
    'outpatient.imaging.draft.set': {
      description: 'Validate and save an imaging request draft (serviceId from imagingServices, free-text indication) without issuing it.',
      enabled: detail.data?.consultation !== undefined
        && detail.data.encounter.status === 'in-progress',
      parameters: {
        type: 'object' as const,
        properties: {
          indication: { type: 'string', minLength: 2, maxLength: 500 },
          serviceId: { type: 'string', maxLength: 128 },
        },
        required: ['indication', 'serviceId'],
        additionalProperties: false,
      },
      execute: async (raw: unknown) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const result = await saveImagingRequestDraft({
          ...agentToolInputSchemas['outpatient.imaging.draft.set'].parse(raw),
          encounterId: current.encounter.id,
          encounterVersion: current.encounter.versionId,
          expectedDraftVersion: current.imagingRequests?.draftVersion ?? 0,
        }, newIdempotencyKey())
        await refreshCaseById(current.caseId)
        hydrateAgentDraft(current.caseId, 'imaging')
        if (activeCaseIdRef.current === current.caseId) {
          selectInvestigation('imaging')
        }
        return result
      },
    },
    'outpatient.pathology.draft.set': {
      description: 'Validate and save a slide consultation draft (serviceId and sourceProcedureReference from pathologyServices, free-text purpose) without issuing it.',
      enabled: detail.data?.consultation !== undefined
        && detail.data.encounter.status === 'in-progress',
      parameters: {
        type: 'object' as const,
        properties: {
          purpose: { type: 'string', minLength: 2, maxLength: 500 },
          serviceId: { type: 'string', maxLength: 128 },
          sourceProcedureReference: { type: 'string', maxLength: 512 },
        },
        required: ['purpose', 'serviceId', 'sourceProcedureReference'],
        additionalProperties: false,
      },
      execute: async (raw: unknown) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const result = await savePathologyRequestDraft({
          ...agentToolInputSchemas['outpatient.pathology.draft.set'].parse(raw),
          encounterId: current.encounter.id,
          encounterVersion: current.encounter.versionId,
          expectedDraftVersion: current.pathologyRequests?.draftVersion ?? 0,
        }, newIdempotencyKey())
        await refreshCaseById(current.caseId)
        hydrateAgentDraft(current.caseId, 'pathology')
        if (activeCaseIdRef.current === current.caseId) {
          selectInvestigation('pathology')
        }
        return result
      },
    },
    'outpatient.laboratory.issue.propose': {
      description: 'Open human review before issuing the current laboratory request.',
      enabled: usesIndependentLaboratoryRequests
        ? detail.data?.laboratoryRequests?.draft !== undefined
        && detail.data.laboratoryRequests.draft.catalogItemId === resolvedLaboratoryItemId
        && detail.data.laboratoryRequests.draft.indicationCode === resolvedIndicationCode
        && !(saveLaboratoryRequest.isPending && saveLaboratoryRequest.variables?.caseId === activeCaseId)
        && !(issueRequest.isPending && issueRequest.variables?.caseId === activeCaseId)
        : detail.data?.drafts?.firstVisit !== undefined,
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: (_raw: unknown, signal: AbortSignal) => agentReview.request({
        confirmLabel: locale => getWorkspaceMessages(locale).issueLaboratoryRequest,
        description: locale => resolvedLaboratoryItem?.[locale === 'zh-CN' ? 'nameZh' : 'nameEn']
          ?? detail.data?.laboratoryRequests?.draft?.laboratoryService?.[locale === 'zh-CN' ? 'nameZh' : 'nameEn']
          ?? detail.data?.laboratoryRequests?.draft?.referenceConcept?.display
          ?? getWorkspaceMessages(locale).consultationUnavailable,
        onConfirm: () => {
          const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
          return usesIndependentLaboratoryRequests
            ? issueRequest.mutateAsync({ caseId: current.caseId })
            : issueOrder.mutateAsync({ caseId: current.caseId })
        },
        signal,
        title: locale => getWorkspaceMessages(locale).issueLaboratoryRequest,
      }),
    },
    'outpatient.laboratory.cancel.propose': {
      description: 'Open human review before cancelling one cancellable laboratory request.',
      enabled: detail.data?.laboratoryRequests?.requests.some(
        isCancellableLaboratoryRequest,
      ) === true,
      parameters: {
        type: 'object' as const,
        properties: { requestId: { type: 'string', maxLength: 128 } },
        required: ['requestId'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const requestId = doctorString(raw, 'requestId', 128)
        const request = current.laboratoryRequests?.requests.find(item => item.id === requestId)
        if (request === undefined || !isCancellableLaboratoryRequest(request)) {
          throw new Error(messages.consultationUnavailable)
        }
        return agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale).confirmCancelLaboratoryRequest,
          description: request.catalogItemId,
          onConfirm: () => cancelRequest.mutateAsync({ caseId: current.caseId, request }),
          signal,
          title: locale => getWorkspaceMessages(locale).cancelLaboratoryRequestTitle,
        })
      },
    },
    'outpatient.report.acknowledge.propose': {
      description: 'Open human review before acknowledging one signed laboratory, imaging or pathology consultation report. An imaging or pathology report can be acknowledged only after its images or slide were opened and displayed to the human reader.',
      enabled: detail.data?.laboratoryRequests?.requests.some(
        request => request.status === 'reported',
      ) === true || detail.data?.imagingRequests?.requests.some(
        request => request.status === 'reported',
      ) === true || detail.data?.pathologyRequests?.requests.some(
        request => request.status === 'reported',
      ) === true,
      parameters: {
        type: 'object' as const,
        properties: { requestId: { type: 'string', maxLength: 128 } },
        required: ['requestId'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const requestId = doctorString(raw, 'requestId', 128)
        const imagingRequest = current.imagingRequests?.requests.find(item => item.id === requestId)
        if (imagingRequest !== undefined) {
          const report = imagingRequest.report
          if (imagingRequest.status !== 'reported' || report === undefined) {
            throw new Error(messages.consultationUnavailable)
          }
          if (!imagingView.isShown(report.diagnosticReportId)) {
            throw new Error('The images have not been displayed to the human reader yet; open them with clinmesh_select_doctor_section and imagingRequestId first')
          }
          return agentReview.request({
            confirmLabel: locale => locale === 'zh-CN' ? '确认已阅' : 'Acknowledge',
            description: imagingRequest.service.name,
            onConfirm: () => runImagingAction(
              current.caseId,
              () => acknowledgeImagingReport(imagingRequest, report, newIdempotencyKey()),
            ),
            signal,
            title: locale => locale === 'zh-CN' ? '确认已阅放射报告' : 'Acknowledge imaging report',
          })
        }
        const pathologyRequest = current.pathologyRequests?.requests.find(item => item.id === requestId)
        if (pathologyRequest !== undefined) {
          const report = pathologyRequest.report
          if (pathologyRequest.status !== 'reported' || report === undefined) {
            throw new Error(messages.consultationUnavailable)
          }
          if (!imagingView.isShown(report.diagnosticReportId)) {
            throw new Error('The slide has not been displayed to the human reader yet; open it with clinmesh_select_doctor_section and pathologyRequestId first')
          }
          return agentReview.request({
            confirmLabel: locale => locale === 'zh-CN' ? '确认已阅' : 'Acknowledge',
            description: pathologyRequest.service.name,
            onConfirm: () => runImagingAction(
              current.caseId,
              () => acknowledgePathologyReport(pathologyRequest, report, newIdempotencyKey()),
            ),
            signal,
            title: locale => locale === 'zh-CN' ? '确认已阅病理会诊报告' : 'Acknowledge pathology consultation report',
          })
        }
        const request = current.laboratoryRequests?.requests.find(item => item.id === requestId)
        if (request?.status !== 'reported' || request.report === undefined) {
          throw new Error(messages.consultationUnavailable)
        }
        return agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale).acknowledgeLaboratoryReport,
          description: request.catalogItemId,
          onConfirm: () => acknowledgeReport.mutateAsync({
            caseId: current.caseId,
            request,
          }),
          signal,
          title: locale => getWorkspaceMessages(locale).acknowledgeLaboratoryReport,
        })
      },
    },
    'outpatient.report.correct.propose': {
      description: 'Open human review before correcting one quantitative laboratory report.',
      enabled: detail.data?.laboratoryRequests?.requests.some(request => (
        request.report !== undefined
        && request.report.results.every(isQuantitativeLaboratoryResult)
      )) === true,
      parameters: {
        type: 'object' as const,
        properties: {
          conclusion: { type: 'string', maxLength: 2_000 },
          reason: { type: 'string', maxLength: 500 },
          requestId: { type: 'string', maxLength: 128 },
          results: {
            type: 'array',
            minItems: 1,
            maxItems: 32,
            items: {
              type: 'object',
              properties: { code: { type: 'string' }, value: { type: 'number' } },
              required: ['code', 'value'],
              additionalProperties: false,
            },
          },
        },
        required: ['conclusion', 'reason', 'requestId', 'results'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const input = reportCorrectionInputSchema.parse(raw)
        const request = current.laboratoryRequests?.requests.find(item => item.id === input.requestId)
        if (
          request?.report === undefined
          || !request.report.results.every(isQuantitativeLaboratoryResult)
        ) throw new Error(messages.consultationUnavailable)
        return agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale).confirmLaboratoryReportCorrection,
          description: `${request.catalogItemId} · ${input.reason}`,
          onConfirm: () => correctReport.mutateAsync({
            caseId: current.caseId,
            input: {
              conclusion: input.conclusion,
              reason: input.reason,
              results: input.results,
            },
            request,
          }),
          signal,
          title: locale => getWorkspaceMessages(locale).previewLaboratoryReportCorrection,
        })
      },
    },
    'outpatient.imaging.issue.propose': {
      description: 'Open human review before issuing the saved imaging request draft.',
      enabled: detail.data?.imagingRequests?.draft !== undefined,
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: (_raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const state = current.imagingRequests
        if (state?.draft === undefined) throw new Error(messages.consultationUnavailable)
        return agentReview.request({
          confirmLabel: locale => locale === 'zh-CN' ? '签发申请' : 'Issue request',
          description: `${state.draft.service.name} · ${state.draft.indication}`,
          onConfirm: async () => {
            const result = await runImagingAction(current.caseId, () => issueImagingRequest({
              encounterId: current.encounter.id,
              encounterVersion: current.encounter.versionId,
              expectedDraftVersion: state.draftVersion,
            }, newIdempotencyKey()))
            hydrateAgentDraft(current.caseId, 'imaging')
            return result
          },
          signal,
          title: locale => locale === 'zh-CN' ? '签发放射申请' : 'Issue imaging request',
        })
      },
    },
    'outpatient.imaging.cancel.propose': {
      description: 'Open human review before cancelling one imaging request that is issued or produced no result.',
      enabled: detail.data?.imagingRequests?.requests.some(
        request => request.status === 'issued' || request.status === 'generation-failed',
      ) === true,
      parameters: {
        type: 'object' as const,
        properties: { requestId: { type: 'string', maxLength: 128 } },
        required: ['requestId'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const requestId = doctorString(raw, 'requestId', 128)
        const request = current.imagingRequests?.requests.find(item => item.id === requestId)
        if (request?.status !== 'issued' && request?.status !== 'generation-failed') {
          throw new Error(messages.consultationUnavailable)
        }
        return agentReview.request({
          confirmLabel: locale => locale === 'zh-CN' ? '取消申请' : 'Cancel request',
          description: request.service.name,
          onConfirm: () => runImagingAction(current.caseId, () => cancelImagingRequest(request, newIdempotencyKey())),
          signal,
          title: locale => locale === 'zh-CN' ? '取消放射申请' : 'Cancel imaging request',
        })
      },
    },
    'outpatient.imaging.retry.propose': {
      description: 'Open human review before retrying one imaging request that produced no result.',
      enabled: detail.data?.imagingRequests?.requests.some(
        request => request.status === 'generation-failed',
      ) === true,
      parameters: {
        type: 'object' as const,
        properties: { requestId: { type: 'string', maxLength: 128 } },
        required: ['requestId'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const requestId = doctorString(raw, 'requestId', 128)
        const request = current.imagingRequests?.requests.find(item => item.id === requestId)
        if (request?.status !== 'generation-failed') throw new Error(messages.consultationUnavailable)
        return agentReview.request({
          confirmLabel: locale => locale === 'zh-CN' ? '重试' : 'Retry',
          description: request.service.name,
          onConfirm: () => runImagingAction(current.caseId, () => retryImagingRequest(request, newIdempotencyKey())),
          signal,
          title: locale => locale === 'zh-CN' ? '重试放射检查' : 'Retry imaging examination',
        })
      },
    },
    'outpatient.imaging.correct.propose': {
      description: 'Open human review before an administrator reissues one imaging report from another reviewed report content revision. The report text itself cannot be rewritten.',
      enabled: canCorrectReports
        && detail.data?.imagingRequests?.requests.some(request => request.report !== undefined) === true,
      parameters: {
        type: 'object' as const,
        properties: {
          reason: { type: 'string', minLength: 2, maxLength: 500 },
          reportRevision: { type: 'integer', minimum: 1 },
          requestId: { type: 'string', maxLength: 128 },
        },
        required: ['reason', 'reportRevision', 'requestId'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const input = agentToolInputSchemas['outpatient.imaging.correct.propose'].parse(raw)
        const request = current.imagingRequests?.requests.find(item => item.id === input.requestId)
        const report = request?.report
        if (request === undefined || report === undefined) throw new Error(messages.consultationUnavailable)
        return agentReview.request({
          confirmLabel: locale => locale === 'zh-CN' ? '提交更正' : 'Submit correction',
          description: `${request.service.name} · ${input.reason}`,
          onConfirm: () => runImagingAction(current.caseId, () => correctImagingReport(
            request,
            report,
            { reason: input.reason, reportRevision: input.reportRevision },
            newIdempotencyKey(),
          )),
          signal,
          title: locale => locale === 'zh-CN' ? '更正放射报告' : 'Correct imaging report',
        })
      },
    },
    'outpatient.pathology.issue.propose': {
      description: 'Open human review before issuing the saved slide consultation draft.',
      enabled: detail.data?.pathologyRequests?.draft !== undefined,
      parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
      execute: (_raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const state = current.pathologyRequests
        if (state?.draft === undefined) throw new Error(messages.consultationUnavailable)
        return agentReview.request({
          confirmLabel: locale => locale === 'zh-CN' ? '签发申请' : 'Issue request',
          description: `${state.draft.service.name} · ${state.draft.sourceProcedure.display ?? state.draft.sourceProcedure.code} · ${state.draft.purpose}`,
          onConfirm: async () => {
            const result = await runImagingAction(current.caseId, () => issuePathologyRequest({
              encounterId: current.encounter.id,
              encounterVersion: current.encounter.versionId,
              expectedDraftVersion: state.draftVersion,
            }, newIdempotencyKey()))
            hydrateAgentDraft(current.caseId, 'pathology')
            return result
          },
          signal,
          title: locale => locale === 'zh-CN' ? '签发病理会诊申请' : 'Issue pathology consultation',
        })
      },
    },
    'outpatient.pathology.cancel.propose': {
      description: 'Open human review before cancelling one slide consultation that is issued or produced no result.',
      enabled: detail.data?.pathologyRequests?.requests.some(
        request => request.status === 'issued' || request.status === 'generation-failed',
      ) === true,
      parameters: {
        type: 'object' as const,
        properties: { requestId: { type: 'string', maxLength: 128 } },
        required: ['requestId'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const requestId = doctorString(raw, 'requestId', 128)
        const request = current.pathologyRequests?.requests.find(item => item.id === requestId)
        if (request?.status !== 'issued' && request?.status !== 'generation-failed') {
          throw new Error(messages.consultationUnavailable)
        }
        return agentReview.request({
          confirmLabel: locale => locale === 'zh-CN' ? '取消申请' : 'Cancel request',
          description: request.service.name,
          onConfirm: () => runImagingAction(current.caseId, () => cancelPathologyRequest(request, newIdempotencyKey())),
          signal,
          title: locale => locale === 'zh-CN' ? '取消病理会诊申请' : 'Cancel pathology consultation',
        })
      },
    },
    'outpatient.pathology.retry.propose': {
      description: 'Open human review before retrying one slide consultation that produced no result.',
      enabled: detail.data?.pathologyRequests?.requests.some(
        request => request.status === 'generation-failed',
      ) === true,
      parameters: {
        type: 'object' as const,
        properties: { requestId: { type: 'string', maxLength: 128 } },
        required: ['requestId'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const requestId = doctorString(raw, 'requestId', 128)
        const request = current.pathologyRequests?.requests.find(item => item.id === requestId)
        if (request?.status !== 'generation-failed') throw new Error(messages.consultationUnavailable)
        return agentReview.request({
          confirmLabel: locale => locale === 'zh-CN' ? '重试' : 'Retry',
          description: request.service.name,
          onConfirm: () => runImagingAction(current.caseId, () => retryPathologyRequest(request, newIdempotencyKey())),
          signal,
          title: locale => locale === 'zh-CN' ? '重试病理会诊' : 'Retry pathology consultation',
        })
      },
    },
    'outpatient.pathology.correct.propose': {
      description: 'Open human review before an administrator reissues one pathology consultation report from another reviewed report content revision. The report text itself cannot be rewritten.',
      enabled: canCorrectReports
        && detail.data?.pathologyRequests?.requests.some(request => request.report !== undefined) === true,
      parameters: {
        type: 'object' as const,
        properties: {
          reason: { type: 'string', minLength: 2, maxLength: 500 },
          reportRevision: { type: 'integer', minimum: 1 },
          requestId: { type: 'string', maxLength: 128 },
        },
        required: ['reason', 'reportRevision', 'requestId'],
        additionalProperties: false,
      },
      execute: (raw: unknown, signal: AbortSignal) => {
        const current = requireDoctorDetail(detail.data, messages.consultationUnavailable)
        const input = agentToolInputSchemas['outpatient.pathology.correct.propose'].parse(raw)
        const request = current.pathologyRequests?.requests.find(item => item.id === input.requestId)
        const report = request?.report
        if (request === undefined || report === undefined) throw new Error(messages.consultationUnavailable)
        return agentReview.request({
          confirmLabel: locale => locale === 'zh-CN' ? '提交更正' : 'Submit correction',
          description: `${request.service.name} · ${input.reason}`,
          onConfirm: () => runImagingAction(current.caseId, () => correctPathologyReport(
            request,
            report,
            { reason: input.reason, reportRevision: input.reportRevision },
            newIdempotencyKey(),
          )),
          signal,
          title: locale => locale === 'zh-CN' ? '更正病理会诊报告' : 'Correct pathology consultation report',
        })
      },
    }
  }
}
