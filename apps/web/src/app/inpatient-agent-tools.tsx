import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { agentToolInputSchemas, parseAgentToolInput, type AgentOperationId, type InpatientStage } from '@clinmesh/contracts/agent'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import type { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { z as schema } from 'zod'
import { inpatientSettlementPreviewSchema } from '@clinmesh/contracts/inpatient-discharge'
import type { paymentSimulatorRuleSchema } from '@clinmesh/contracts/his'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { yuanToFen } from './workspace-format.ts'
import { agentViewRevision, useRegisterAgentPage } from './agent-page-context.tsx'
import { useAgentReview } from './agent-review.tsx'
import type { SurfaceAgentPageAction } from './surface-agent-tools.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

interface Input {
  admission: InpatientAdmission
  session: SessionContext
  stage: InpatientStage
  stages: readonly { value: string }[]
  onStageChange(stage: string): void
  clinical: z.infer<typeof inpatientFullClinicalSchema> | undefined
  investigations: z.infer<typeof inpatientInvestigationsSchema> | undefined
  bedLabel: string
  write: ReturnType<typeof useInpatientWriteIntent>
  locale: WorkspaceLocale
}

type Method = 'cash' | 'bank-card' | 'mobile'
interface PaymentDraft {
  amounts: Record<Method, string>
  assisted: Partial<Record<Method, boolean>>
  kind: 'deposit' | 'supplement'
  rule: z.infer<typeof paymentSimulatorRuleSchema>
}
interface ReportIdentity { admissionId: string; requestId: string; diagnosticReportId: string; diagnosticReportVersion: string }
interface InpatientAgentState { payment: PaymentDraft; updatePayment(patch: Partial<PaymentDraft>): void; setReportShown(report: ReportIdentity, shown: boolean): void }
const AgentState = createContext<InpatientAgentState | null>(null)
export function InpatientAgentProvider({ value, children }: { value: InpatientAgentState; children: ReactNode }) {
  return <AgentState.Provider value={value}>{children}</AgentState.Provider>
}
export function useInpatientAgentState() { return useContext(AgentState) }

function parameters(operation: AgentOperationId): SurfaceAgentPageAction['parameters'] {
  const json = schema.toJSONSchema(agentToolInputSchemas[operation])
  return { type: 'object', properties: json.properties ?? {}, required: json.required ?? [], additionalProperties: false }
}

export const inpatientOrderAnchor = (admissionId: string, orderId: string) => `${admissionId}:order:${orderId}`
export const inpatientReportAnchor = (admissionId: string, requestId: string) => `${admissionId}:report:${requestId}`

function sessionNamespace(session: SessionContext): string {
  return JSON.stringify([session.user.id, ...(['actorId', 'workspaceId', 'epoch', 'scenarioRunId', 'practitionerRoleId',
    'roleCode', 'organizationId', 'locationId', 'practitionerId'] as const).map(key => session.actor[key])])
}
function reportIdentity(report: ReportIdentity): string {
  return JSON.stringify([report.admissionId, report.requestId, report.diagnosticReportId, report.diagnosticReportVersion])
}

export function useInpatientAgentTools(input: Input) {
  const review = useAgentReview(), latest = useRef(input)
  const namespace = sessionNamespace(input.session)
  const client = useQueryClient()
  const [payment, setPayment] = useState<PaymentDraft>({ amounts: { cash: '', 'bank-card': '', mobile: '' }, assisted: {},
    kind: input.admission.status === 'departed' ? 'supplement' : 'deposit', rule: 'success' })
  const updatePayment = useCallback((patch: Partial<PaymentDraft>) => setPayment(current => ({ ...current, ...patch })), [])
  const draftRef = useRef(payment)
  const shownReports = useRef(new Set<string>())
  const setReportShown = useCallback((report: ReportIdentity, shown: boolean) => {
    if (sessionNamespace(latest.current.session) !== namespace) return
    const key = reportIdentity(report)
    if (shown) shownReports.current.add(key)
    else shownReports.current.delete(key)
  }, [namespace])
  useLayoutEffect(() => { draftRef.current = payment })
  useLayoutEffect(() => {
    if (sessionNamespace(latest.current.session) !== namespace) shownReports.current.clear()
    latest.current = input
  })
  const revision = agentViewRevision({ account: input.session.user.id, actor: input.session.actor, admission: input.admission, stage: input.stage,
    clinical: input.clinical, investigations: input.investigations, payment })
  useEffect(() => () => review.cancel('当前岗位或患者资料已变化，请重新准备。'), [review, revision, namespace])
  const t = (cn: string, en: string) => input.locale === 'zh-CN' ? cn : en
  const current = () => {
    const frame = latest.current
    if (frame.admission.id !== input.admission.id || frame.admission.versionId !== input.admission.versionId
      || frame.stage !== input.stage || sessionNamespace(frame.session) !== namespace
      || frame.write.blocked) throw new Error(t('当前岗位或患者资料已变化，请重新准备。', 'The current role or patient details changed. Prepare the action again.'))
    return frame
  }
  useRegisterAgentPage({
    label: t('住院工作台', 'Inpatient workspace'),
    claim: { version: 1, viewId: 'inpatient', viewRevision: revision, activeSection: input.stage,
      selection: { kind: 'inpatient-admission', id: input.admission.id, version: input.admission.versionId },
      ...(input.session.actor.roleCode === 'cashier' ? { draft: { kind: 'inpatient-payment', id: `${input.admission.id}:inpatient-payment`,
        revision: agentViewRevision(payment), dirty: Object.values(payment.amounts).some(Boolean) } } : {}),
      ui: { status: 'ready' } },
    readState: () => ({ admission: input.admission, stage: input.stage, bed: input.bedLabel,
      ...(input.session.actor.roleCode === 'cashier' ? { payment: draftRef.current } : {}),
      ...(input.session.actor.roleCode === 'ward-nurse' || input.session.actor.roleCode === 'inpatient-doctor'
        ? { clinical: input.clinical, investigations: input.investigations } : {}) }),
    actions: {
      'inpatient.report.acknowledge.propose': {
        description: 'Prepare acknowledgement of the current inpatient report. Imaging requires an image actually displayed for the doctor.',
        parameters: parameters('inpatient.report.acknowledge.propose'),
        enabled: input.session.actor.roleCode === 'inpatient-doctor' && input.stage === 'investigations' && !input.write.blocked,
        execute(raw, signal) {
          const values = parseAgentToolInput('inpatient.report.acknowledge.propose', raw)
          const check = () => {
            const frame = current()
            const request = [...frame.investigations?.laboratoryRequests ?? [], ...frame.investigations?.imagingRequests ?? []].find(request => request.id === values.requestId)
            if (frame.session.actor.roleCode !== 'inpatient-doctor' || frame.stage !== 'investigations' || !request?.report
              || request.status !== 'reported' || request.version !== values.expectedRequestVersion
              || request.serviceRequestVersion !== values.serviceRequestVersion || request.taskVersion !== values.taskVersion
              || request.report.diagnosticReportId !== values.diagnosticReportId || request.report.diagnosticReportVersion !== values.diagnosticReportVersion) {
              throw new Error(t('报告已变化，请核对当前报告后重新准备。', 'The report changed. Review the current report and prepare again.'))
            }
            if ('service' in request && !shownReports.current.has(reportIdentity({ admissionId: frame.admission.id, requestId: request.id,
              diagnosticReportId: values.diagnosticReportId, diagnosticReportVersion: values.diagnosticReportVersion }))) {
              throw new Error(t('请先实际查看该报告的影像，再准备已阅。', 'Display the images for this report before preparing acknowledgement.'))
            }
            return frame
          }
          check()
          return review.request({ anchor: inpatientReportAnchor(input.admission.id, values.requestId), signal,
            title: t('已阅报告', 'Acknowledge report'), confirmLabel: t('已阅', 'Acknowledge'),
            description: `${input.admission.patientName} · ${t('请核对报告内容后确认。', 'Review the report before confirming.')}`,
            onConfirm: async () => {
              const frame = check()
              return (await frame.write.mutation.mutateAsync({ operation: 'inpatient.investigation.acknowledge', input: { ...values, admissionId: frame.admission.id } })).response
            },
          })
        },
      },
      'inpatient.payment.draft.set': {
        description: 'Fill the current inpatient discharge collection amounts without collecting money.',
        parameters: parameters('inpatient.payment.draft.set'), enabled: input.session.actor.roleCode === 'cashier' && input.stage === 'discharge',
        execute(raw) {
          const frame = current(), { tenders } = parseAgentToolInput('inpatient.payment.draft.set', raw)
          if (frame.session.actor.roleCode !== 'cashier' || frame.stage !== 'discharge') throw new Error(t('请由收费员在出院环节准备补交。', 'The cashier prepares discharge collection.'))
          const amounts: Record<Method, string> = { cash: '', 'bank-card': '', mobile: '' }, assisted: Partial<Record<Method, boolean>> = {}
          for (const tender of tenders) { amounts[tender.method] = (tender.amountFen / 100).toFixed(2); assisted[tender.method] = true }
          updatePayment({ amounts, assisted, kind: 'supplement' })
          return { prepared: true, tenders }
        },
      },
      'inpatient.payment.preview': {
        description: 'Preview the discharge collection; the cashier confirms collection on the page.',
        parameters: parameters('inpatient.payment.preview'), enabled: input.session.actor.roleCode === 'cashier' && input.stage === 'discharge',
        async execute(raw) {
          parseAgentToolInput('inpatient.payment.preview', raw)
          const frame = current(), draft = draftRef.current
          if (frame.session.actor.roleCode !== 'cashier' || frame.stage !== 'discharge' || frame.admission.status !== 'departed') throw new Error(t('请由收费员在出院环节预览补交。', 'The cashier previews discharge collection.'))
          const tenders = (Object.keys(draft.amounts) as Method[]).flatMap(method => {
            const amountFen = yuanToFen(draft.amounts[method] || '0')
            if (amountFen === undefined) throw new Error(t('请核对收款金额。', 'Check the collection amount.'))
            return amountFen > 0 ? [{ method, amountFen }] : []
          })
          if (!tenders.length && frame.admission.outstandingFen && frame.admission.outstandingFen > 0) tenders.push({ method: 'cash', amountFen: frame.admission.outstandingFen })
          const parsed = parseAgentToolInput('inpatient.payment.draft.set', { tenders })
          return (await frame.write.mutation.mutateAsync({ operation: 'inpatient.payment.preview', input: { admissionId: frame.admission.id,
            kind: 'supplement', amountFen: parsed.tenders.reduce((sum, item) => sum + item.amountFen, 0), tenders: parsed.tenders, simulatorRule: draft.rule } })).response
        },
      },
      'inpatient.settlement.preview': {
        description: 'Read the current inpatient settlement preview without settling the admission.',
        parameters: parameters('inpatient.settlement.preview'), enabled: input.session.actor.roleCode === 'cashier' && input.stage === 'discharge',
        async execute(raw) {
          parseAgentToolInput('inpatient.settlement.preview', raw)
          const frame = current()
          if (frame.session.actor.roleCode !== 'cashier' || frame.stage !== 'discharge') throw new Error(t('请由收费员预览结算。', 'The cashier previews settlement.'))
          return client.fetchQuery({ queryKey: [...inpatientScopeKey(frame.session), frame.admission.id, 'settlement-preview'], staleTime: 0,
            queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${frame.admission.id}/discharge/preview`, inpatientSettlementPreviewSchema, signal) })
        },
      },
      'inpatient.stage.select': {
        description: 'Select a readable stage for the currently selected inpatient.', parameters: parameters('inpatient.stage.select'),
        execute(raw) {
          const frame = current(), { stage } = parseAgentToolInput('inpatient.stage.select', raw)
          if (!frame.stages.some(item => item.value === stage)) throw new Error(t('当前岗位不能进入该环节。', 'This role cannot open that stage.'))
          frame.onStageChange(stage)
          return { stage, selected: true }
        },
      },
      'inpatient.order.verify.propose': {
        description: 'Prepare nurse verification for one current inpatient order. The nurse confirms on its row.',
        parameters: parameters('inpatient.order.verify.propose'),
        enabled: input.session.actor.roleCode === 'ward-nurse' && input.stage === 'orders' && !input.write.blocked,
        execute(raw, signal) {
          const values = parseAgentToolInput('inpatient.order.verify.propose', raw)
          const check = () => {
            const frame = current(), order = frame.clinical?.orders.find(order => order.id === values.orderId)
            if (frame.session.actor.roleCode !== 'ward-nurse' || frame.stage !== 'orders'
              || !order || order.state !== 'signed' || order.version !== values.expectedOrderVersion) {
              throw new Error(t('医嘱已变化，请核对当前医嘱后重新准备。', 'The order changed. Review it and prepare again.'))
            }
            return { frame, order }
          }
          const { order } = check()
          return review.request({ anchor: inpatientOrderAnchor(input.admission.id, order.id), signal,
            title: t('校对医嘱', 'Verify order'), confirmLabel: t('确认校对', 'Confirm verification'),
            description: `${input.bedLabel} · ${input.admission.patientName} · ${order.display} · ${order.doseText}`,
            onConfirm: async () => {
              const { frame } = check()
              const result = await frame.write.mutation.mutateAsync({ operation: 'inpatient.order.verify', input: { ...values, admissionId: frame.admission.id } })
              return result.response
            },
          })
        },
      },
    },
  })
  return { payment, updatePayment, setReportShown }
}
