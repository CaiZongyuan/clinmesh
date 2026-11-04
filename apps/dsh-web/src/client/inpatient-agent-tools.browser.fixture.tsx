import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { Button } from '@clinmesh/ui/components/button'
import { AgentPageRegistryProvider, useAgentPageRegistration } from '../../../web/src/app/agent-page-context.tsx'
import { AgentReviewProvider, isAgentReviewTask } from '../../../web/src/app/agent-review.tsx'
import { InpatientWorkspace } from '../../../web/src/app/inpatient-workspace.tsx'
import { apiGet, getSession } from '../../../web/src/app/api-client.ts'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientDetailSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { z } from 'zod'
import { InpatientAgentProvider, useInpatientAgentTools } from '../../../web/src/app/inpatient-agent-tools.tsx'
import { InpatientClinical } from '../../../web/src/app/inpatient-clinical.tsx'
import { InpatientInvestigations } from '../../../web/src/app/inpatient-investigations.tsx'
import { useInpatientWriteIntent } from '../../../web/src/app/inpatient-write-intent.ts'
import { WorkspaceCardLayout } from '../../../web/src/app/workspace-card-layout.tsx'
import type { SurfaceAgentPageAction } from '../../../web/src/app/surface-agent-tools.ts'

const host = document.createElement('div')
host.style.cssText = 'width:944px;height:720px'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const container = document.createElement('main')
container.className = 'clinmesh-web-root'
container.dataset.clinmeshApp = 'web'
container.style.height = '100%'
shadow.append(container)

function Controls({ changeNamespace, changeReport }: { changeNamespace?: (part: string) => void; changeReport?: () => void }) {
  const registration = useAgentPageRegistration()
  const controller = React.useRef(new AbortController())
  const [result, setResult] = React.useState('尚未准备')
  const captured = React.useRef<SurfaceAgentPageAction | undefined>(undefined)
  const execute = async (action: SurfaceAgentPageAction | undefined, input: unknown) => {
    if (!action) { setResult('工具未发布'); return }
    try {
      const task = await action.execute(input, controller.current.signal)
      if (isAgentReviewTask(task)) {
        task.bindDecisionGate(async () => {})
        void task.decision.then(value => setResult(value.approved ? '人工已确认' : '人工未采用'), error => setResult(error.message))
        setResult('等待人工确认')
      } else setResult('准备完成')
    }
    catch (error) { setResult(error instanceof Error ? error.message : '准备失败') }
  }
  const prepare = (operation: string, input: unknown = {}) => execute(registration?.actions[operation], input)
  const disabled = (operation: string) => !registration?.actions[operation] || registration.actions[operation]?.enabled === false
  return <div className="flex flex-wrap gap-2">
    <Button disabled={disabled('inpatient.order.verify.propose')} onClick={() => {
      controller.current = new AbortController()
      void prepare('inpatient.order.verify.propose', { orderId: document.documentElement.dataset.orderId, expectedOrderVersion: 1 })
    }}>助手准备校对</Button>
    <Button onClick={() => controller.current.abort()}>中止助手</Button>
    <Button disabled={disabled('inpatient.payment.draft.set')} onClick={() => prepare('inpatient.payment.draft.set', { tenders: [{ method: 'cash', amountFen: 5000 }] })}>助手填写补交</Button>
    <Button disabled={disabled('inpatient.payment.preview')} onClick={() => prepare('inpatient.payment.preview')}>助手预览收款</Button>
    <Button disabled={disabled('inpatient.settlement.preview')} onClick={() => prepare('inpatient.settlement.preview')}>助手预览结算</Button>
    <Button disabled={disabled('inpatient.stage.select')} onClick={() => prepare('inpatient.stage.select', { stage: 'investigations' })}>助手切到检查检验</Button>
    <Button disabled={disabled('inpatient.report.acknowledge.propose')} onClick={() => prepare('inpatient.report.acknowledge.propose', { requestId: 'synthetic-imaging-request', expectedRequestVersion: 3,
      serviceRequestVersion: '2', taskVersion: '3', diagnosticReportId: 'synthetic-imaging-report', diagnosticReportVersion: '1' })}>助手准备已阅</Button>
    {changeNamespace ? <>
      <Button onClick={() => { captured.current = registration?.actions['inpatient.order.verify.propose']; setResult('已捕获校对任务') }}>捕获当前校对任务</Button>
      {['actor', 'workspace', 'epoch', 'account', 'scenario', 'role', 'roleCode', 'organization', 'ward', 'practitioner'].map(part => <Button key={part} onClick={() => changeNamespace(part)}>切换 {part}</Button>)}
      <Button onClick={() => execute(captured.current, { orderId: document.documentElement.dataset.orderId, expectedOrderVersion: 1 })}>执行旧校对任务</Button>
    </> : null}
    {changeReport ? <>
      <Button onClick={changeReport}>接收新报告上下文</Button>
      <Button onClick={() => {
        const state = z.object({ investigations: inpatientInvestigationsSchema }).parse(registration?.readState())
        const request = state.investigations.imagingRequests[0]!
        void prepare('inpatient.report.acknowledge.propose', { requestId: request.id, expectedRequestVersion: request.version,
          serviceRequestVersion: request.serviceRequestVersion, taskVersion: request.taskVersion,
          diagnosticReportId: request.report!.diagnosticReportId, diagnosticReportVersion: request.report!.diagnosticReportVersion })
      }}>准备当前报告已阅</Button>
    </> : null}
    <output aria-label="助手结果">{result}</output>
    <output className="sr-only" aria-label="当前上下文">{JSON.stringify(registration?.readState())}</output>
  </div>
}

function BindingContent({ initialSession, admission, clinical, investigations }: { initialSession: SessionContext;
  admission: z.infer<typeof inpatientDetailSchema>['admission']; clinical: z.infer<typeof inpatientFullClinicalSchema>; investigations: z.infer<typeof inpatientInvestigationsSchema> }) {
  const [session, setSession] = React.useState(initialSession), [context, setContext] = React.useState(investigations)
  const client = useQueryClient()
  const write = useInpatientWriteIntent(session, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
  const reportMode = document.documentElement.dataset.bindingMode === 'report'
  const stage = reportMode ? 'investigations' : 'orders'
  const controller = useInpatientAgentTools({ session, admission, clinical, investigations: context, stage,
    stages: [{ value: stage }], onStageChange() {}, bedLabel: '1床', write, locale: 'zh-CN' })
  const changeNamespace = (part: string) => setSession(current => {
    if (part === 'account') return { ...current, user: { ...current.user, id: 'account-collision' } }
    const changes: Record<string, Partial<SessionContext['actor']>> = {
      actor: { actorId: 'actor-collision' }, workspace: { workspaceId: 'workspace-collision' }, epoch: { epoch: 'epoch-collision' },
      scenario: { scenarioRunId: 'scenario-collision' }, role: { practitionerRoleId: 'role-collision' }, roleCode: { roleCode: 'inpatient-doctor' },
      organization: { organizationId: 'organization-collision' }, ward: { locationId: 'ward-collision' }, practitioner: { practitionerId: 'practitioner-collision' },
    }
    return { ...current, actor: { ...current.actor, ...changes[part] } }
  })
  const changeReport = () => setContext(current => ({ ...current, imagingRequests: current.imagingRequests.map(request => request.report ? { ...request,
    version: request.version + 1, report: { ...request.report, diagnosticReportId: `${request.report.diagnosticReportId}-new`, diagnosticReportVersion: '1',
      revisionNumber: request.report.revisionNumber + 1, revisionOfDiagnosticReportId: request.report.diagnosticReportId, revisionReason: '合成报告更正', findings: '合成新报告所见' } } : request) }))
  return <InpatientAgentProvider value={controller}>
    <Controls {...(reportMode ? { changeReport } : { changeNamespace })} />
    <output aria-label="当前身份范围">{JSON.stringify({ account: session.user.id, ...session.actor })}</output>
    <div style={{ height: '580px', display: 'flex' }}><WorkspaceCardLayout id="binding-contract" locale="zh-CN">
      {reportMode ? <InpatientInvestigations admission={admission} session={session} locale="zh-CN" write={write} />
        : <InpatientClinical admission={admission} session={session} locale="zh-CN" write={write} />}
    </WorkspaceCardLayout></div>
  </InpatientAgentProvider>
}

function BindingWorkspace({ session }: { session: SessionContext }) {
  const id = document.documentElement.dataset.admissionId!, path = `/api/his/v1/inpatient/admissions/${id}`
  const admission = useQuery({ queryKey: ['binding-admission', id], queryFn: ({ signal }) => apiGet(path, inpatientDetailSchema, signal) })
  const clinical = useQuery({ queryKey: ['binding-clinical', id], queryFn: ({ signal }) => apiGet(`${path}/clinical`, inpatientFullClinicalSchema, signal) })
  const investigations = useQuery({ queryKey: ['binding-investigations', id], queryFn: ({ signal }) => apiGet(`${path}/investigations`, inpatientInvestigationsSchema, signal) })
  return admission.data && clinical.data && investigations.data ? <BindingContent initialSession={session} admission={admission.data.admission} clinical={clinical.data} investigations={investigations.data} /> : <p>正在读取合成绑定资料</p>
}

void getSession().then((session: SessionContext) => createRoot(container).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PortalContainerProvider container={container}><AgentReviewProvider><AgentPageRegistryProvider>
      {document.documentElement.dataset.bindingMode ? <BindingWorkspace session={session} /> : <><Controls /><div style={{ height: '640px', display: 'flex' }}><InpatientWorkspace session={session} locale="zh-CN" /></div></>}
    </AgentPageRegistryProvider></AgentReviewProvider></PortalContainerProvider>
  </QueryClientProvider>,
))
