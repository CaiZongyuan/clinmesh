import './inpatient-workspace.css'
import { InpatientPatientWorkspace, inpatientStatus } from './inpatient-patient-workspace.tsx'
import { InpatientNurseBench } from './inpatient-nurse-bench.tsx'
import { InpatientDoctorPatientList } from './inpatient-doctor-patient-list.tsx'
import { InpatientInsuranceReview } from './inpatient-insurance-review.tsx'
import { inpatientTransferCatalogSchema } from '@clinmesh/contracts/inpatient-transfer'
import { InpatientIncomingTransfers } from './inpatient-transfers.tsx'
import { scenarioStateSchema, type PatientSummary, type SessionContext } from '@clinmesh/contracts/his'
import { startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { inpatientCatalogSchema, inpatientListSchema, inpatientCommandResponseSchema,
  inpatientReferralListSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet, getSyntheticCasesAwaitingRegistration, searchPatients } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen, yuanToFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { WorkspaceModeSwitch } from './workspace-mode.tsx'
import { WorkspaceCardLayout, WorkspaceCard, WorkspaceQueueCard, WorkspacePatientCard, WorkspaceActionBar, useWorkspaceCardView } from './workspace-card-layout.tsx'
import { inpatientFlow } from './inpatient-stage-activity.ts'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'

export { yuanToFen } from './workspace-format.ts'

export function InpatientWorkspace({ session, locale }: { session: SessionContext; locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const client = useQueryClient()
  const key = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const insuranceOffice = session.actor.roleCode === 'medical-insurance'
  const catalog = useQuery({ queryKey: [...key, 'catalog'], enabled: !insuranceOffice, queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/catalog', inpatientCatalogSchema, signal) })
  const admissions = useQuery({ queryKey: [...key, 'admissions'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema, signal) })
  const registrar = session.actor.roleCode === 'registrar'
  const nurse = session.actor.roleCode === 'ward-nurse'
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], enabled: session.actor.roleCode === 'inpatient-doctor',
    queryFn: ({ signal }) => apiGet('/api/sim/v1/scenario-runs/current', scenarioStateSchema, signal), retry: false })
  const transferCatalog = useQuery({ queryKey: [...key, 'transfer-catalog'], enabled: nurse || session.actor.roleCode === 'inpatient-doctor',
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/transfer-catalog', inpatientTransferCatalogSchema, signal) })
  const allowTransfers = (transferCatalog.data?.wards.length ?? 0) > 1
  const referrals = useQuery({ queryKey: [...key, 'referrals'], enabled: registrar,
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/referrals', inpatientReferralListSchema, signal) })
  const [search, setSearch] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [patient, setPatient] = useState<PatientSummary>()
  const [route, setRoute] = useState<'direct' | 'outpatient' | 'transfer'>('direct')
  const [source, setSource] = useState<'patient' | 'synthetic'>('patient')
  const [caseId, setCaseId] = useState<string | null>(null)
  const [casePage, setCasePage] = useState(1)
  const [referralId, setReferralId] = useState<string | null>(null)
  const [wardId, setWardId] = useState<string | null>(null)
  const [deposit, setDeposit] = useState('0.00')
  const [selectedId, setSelectedId] = useState<string>()
  const fromCase = route === 'direct' && source === 'synthetic'
  const cases = useQuery({ queryKey: [...key, 'synthetic-cases', casePage], enabled: registrar && fromCase,
    queryFn: ({ signal }) => getSyntheticCasesAwaitingRegistration(signal, casePage) })
  const selectedCase = cases.data?.items.find(item => item.caseId === caseId)
  const patients = useQuery({ queryKey: [...key, 'patients', searchTerm], enabled: registrar && searchTerm.length > 0,
    queryFn: ({ signal }) => searchPatients(searchTerm, signal) })
  const selected = admissions.data?.items.find(admission => admission.id === selectedId)
  const referral = referrals.data?.items.find(item => item.id === referralId)
  const availableWards = (catalog.data?.wards ?? []).filter(ward => ward.acceptingAdmissions !== false)
  const receivingWardId = route === 'outpatient' ? referral?.wardId ?? null : wardId ?? (availableWards.length === 1 ? availableWards[0]!.id : null)
  const receivingWard = catalog.data?.wards.find(ward => ward.id === receivingWardId)
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['inpatient'] }), client.invalidateQueries({ queryKey: ['scenario', 'virtual-time'] })])
  const write = useInpatientWriteIntent(session, async (command, response) => {
    if (command.operation === 'inpatient.admission.register') setSelectedId(inpatientCommandResponseSchema.parse(response).data.admission.id)
    if (command.operation === 'registration.synthetic-case.start-inpatient') setSelectedId(startSyntheticInpatientCaseResponseSchema.parse(response).data.admissionId)
    await refresh()
  })
  const register = () => {
    if (fromCase) {
      if (selectedCase === undefined || receivingWardId === null) return
      write.mutation.mutate({ operation: 'registration.synthetic-case.start-inpatient', input: {
        caseId: selectedCase.caseId, expectedEpoch: session.actor.epoch, expectedCaseRevision: selectedCase.caseRevision,
        activeBriefRevision: selectedCase.activeBriefRevision, wardId: receivingWardId,
      } })
      return
    }
    const target = route === 'outpatient' ? referral && { id: referral.patientId, versionId: referral.patientVersion } : patient
    const amount = yuanToFen(deposit)
    if (target === undefined || receivingWardId === null || amount === undefined) return
    write.mutation.mutate({ operation: 'inpatient.admission.register', input: {
      expectedEpoch: session.actor.epoch, patientId: target.id, patientVersion: target.versionId,
      admissionRoute: route, wardId: receivingWardId, depositFen: amount, ...(route === 'outpatient' && referralId !== null ? { referralId } : {}),
    } })
  }
  const error = catalog.error ?? transferCatalog.error ?? admissions.error ?? scenario.error ?? patients.error ?? referrals.error ?? write.storageFailure ?? write.mutation.error
  const errorLabel = catalog.error ? zh ? '病区目录读取失败：' : 'Ward catalog failed to load: '
    : transferCatalog.error ? zh ? '转科病区读取失败：' : 'Transfer wards failed to load: '
      : admissions.error ? zh ? '住院患者读取失败：' : 'Inpatient queue failed to load: '
        : scenario.error ? zh ? '住院时间读取失败：' : 'Hospital time failed to load: '
        : patients.error ? zh ? '患者检索失败：' : 'Patient search failed: '
          : referrals.error ? zh ? '住院证读取失败：' : 'Admission referrals failed to load: '
            : zh ? '住院操作未完成：' : 'Inpatient action failed: '
  const messages = getWorkspaceMessages(locale)
  const recordView = useWorkspaceCardView(`inpatient-queue-${session.actor.workspaceId}-${session.actor.epoch}-${session.actor.practitionerRoleId}`)
  const recordStatus = recordView.tab ?? 'all'
  const items = (admissions.data?.items ?? []).filter(item => session.actor.roleCode !== 'medical-records' || recordStatus === 'all' || item.recordStatus === recordStatus)
  const registrationFormId = `${session.actor.practitionerRoleId}-admission-form`
  const registrationBlocked = write.blocked || receivingWardId === null || (fromCase ? selectedCase === undefined || cases.isFetching : (route === 'outpatient' ? referral === undefined : patient === undefined) || yuanToFen(deposit) === undefined)
  const registrationForm = registrar ? <form id={registrationFormId} onSubmit={event => { event.preventDefault(); register() }}>
      <FieldSet disabled={write.blocked}><FieldGroup className="grid gap-3 md:grid-cols-2">
        <Field><FieldLabel htmlFor="inpatient-route">{zh ? '入院途径' : 'Admission route'}</FieldLabel>
          <WorkspaceSelect id="inpatient-route" value={route} items={[{ value: 'direct', label: zh ? '直接入院' : 'Direct' },
            { value: 'outpatient', label: zh ? '门诊住院证转收' : 'Outpatient referral' }, { value: 'transfer', label: zh ? '转院' : 'Transfer from another hospital' }]}
            onValueChange={value => { if (value !== null) setRoute(value) }} /></Field>
        {route === 'direct' ? <Field><FieldLabel htmlFor="inpatient-source">{zh ? '患者来源' : 'Patient source'}</FieldLabel>
          <WorkspaceSelect id="inpatient-source" value={source} items={[{ value: 'patient', label: zh ? '已有患者' : 'Existing patient' },
            { value: 'synthetic', label: zh ? '就绪合成病例' : 'Ready synthetic case' }]} onValueChange={value => { if (value !== null) setSource(value) }} /></Field> : null}
        {route === 'outpatient' ? <Field><FieldLabel htmlFor="inpatient-referral">{zh ? '住院证' : 'Admission referral'}</FieldLabel>
          <WorkspaceSelect id="inpatient-referral" value={referralId} items={(referrals.data?.items ?? []).filter(item => item.status === 'issued')
            .map(item => ({ value: item.id, label: `${item.patientName} · ${item.reason}` }))} onValueChange={value => {
              setReferralId(value)
            }} /></Field> : fromCase ? <Field className="md:col-span-2">
          <FieldLabel htmlFor="inpatient-synthetic-case">{zh ? '待住院合成病例' : 'Synthetic case for admission'}</FieldLabel>
          <WorkspaceSelect id="inpatient-synthetic-case" value={selectedCase?.caseId ?? null}
            items={(cases.data?.items ?? []).map(item => ({ value: item.caseId, label: `${item.name} · ${item.mrn}` }))} onValueChange={setCaseId} />
          {cases.isPending ? <p role="status">{zh ? '正在加载就绪病例' : 'Loading ready cases'}</p> : null}
          {cases.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(cases.error, messages)}</AlertDescription></Alert> : null}
          {cases.data?.total === 0 ? <FieldDescription>{zh ? '暂无就绪病例，请管理员准备病例及有效患者档案。固定 PCI 病例准备后可直接选用。' : 'No ready cases. Ask an administrator to prepare a case with an active patient persona. Fixed PCI preparation selects the persona automatically.'}</FieldDescription> : null}
          {selectedCase ? <FieldDescription>{zh ? '病例' : 'Case'} {selectedCase.caseId} · {zh ? '患者档案修订' : 'Patient profile revision'} {selectedCase.profileRevision} · {zh ? '患者自述修订' : 'Patient statement revision'} {selectedCase.activeBriefRevision}</FieldDescription> : null}
          <FieldDescription>{zh ? '直接入院后由病区护士接诊；预交金在独立资金流程办理。' : 'The ward nurse receives the admission. Collect deposits through the separate payment workflow.'}</FieldDescription>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={cases.isFetching} onClick={() => { setCaseId(null); void cases.refetch() }}>{zh ? '刷新就绪病例' : 'Refresh ready cases'}</Button>
            <Button type="button" variant="outline" disabled={casePage === 1 || cases.isFetching} onClick={() => { setCaseId(null); setCasePage(value => value - 1) }}>{zh ? '上一页' : 'Previous'}</Button>
            <Button type="button" variant="outline" disabled={cases.data === undefined || casePage * cases.data.pageSize >= cases.data.total || cases.isFetching} onClick={() => { setCaseId(null); setCasePage(value => value + 1) }}>{zh ? '下一页' : 'Next'}</Button>
          </div>
        </Field> : <>
          <Field><FieldLabel htmlFor="inpatient-search">{zh ? '搜索住院患者' : 'Search inpatient patient'}</FieldLabel>
            <div className="flex gap-2"><Input id="inpatient-search" value={search} onChange={event => setSearch(event.currentTarget.value)} />
              <Button type="button" variant="outline" onClick={() => setSearchTerm(search.trim())}>{zh ? '搜索患者' : 'Search patients'}</Button></div></Field>
          <Field><FieldLabel htmlFor="inpatient-patient">{zh ? '住院患者' : 'Patient'}</FieldLabel>
            <WorkspaceSelect id="inpatient-patient" value={patient?.id ?? null} items={(patients.data?.items ?? []).map(item => ({ value: item.id, label: `${item.name} · ${item.identifier}` }))}
              onValueChange={value => setPatient(patients.data?.items.find(item => item.id === value))} /></Field>
        </>}
        <Field><FieldLabel htmlFor="inpatient-ward">{zh ? '入院病区' : 'Admission ward'}</FieldLabel>
          {route === 'outpatient' || availableWards.length === 1 ? <Input id="inpatient-ward" readOnly value={receivingWard?.name ?? ''} /> : <WorkspaceSelect id="inpatient-ward" value={receivingWardId} items={availableWards.map(ward => ({ value: ward.id, label: ward.name }))} onValueChange={setWardId} />}</Field>
        {fromCase ? null : <Field><FieldLabel htmlFor="inpatient-deposit">{zh ? '预交金（元）' : 'Deposit (CNY)'}</FieldLabel>
          <Input id="inpatient-deposit" min="0" step="0.01" type="number" value={deposit} onChange={event => setDeposit(event.currentTarget.value)} required /></Field>}
      </FieldGroup></FieldSet>
    </form> : null
  const notices = <>
    {error ? <Alert variant="destructive"><AlertDescription>{errorLabel}{getWorkspaceErrorMessage(error, messages)} <Button variant="outline" size="sm" onClick={() => { void refresh(); void catalog.refetch() }}>{zh ? '重试读取' : 'Retry loading'}</Button></AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
  </>
  const queueRows = (rows: InpatientAdmission[]) => rows.map(admission => <Button key={admission.id} variant="ghost" className="h-auto w-full justify-start whitespace-normal px-2 py-3 text-start" aria-current={selectedId === admission.id ? 'true' : undefined}
    aria-label={`${zh ? '查看' : 'View '}${admission.patientName}`} onClick={() => setSelectedId(admission.id)}>
    <span className="flex min-w-0 flex-col gap-1"><strong>{admission.patientName}</strong><span className="text-xs text-muted-foreground">{catalog.data?.wards.find(ward => ward.id === admission.wardId)?.name} {catalog.data?.beds.find(bed => bed.id === admission.bedId)?.name} · {inpatientStatus(admission, locale)}</span><span className="tabular-nums text-xs text-muted-foreground">{admission.inpatientNumber}</span></span>
  </Button>)
  const queue = <WorkspaceQueueCard title={<h2>{nurse ? zh ? '本病区' : 'My ward' : session.actor.roleCode === 'medical-records' ? zh ? '病案队列' : 'Medical records queue' : zh ? '住院患者' : 'Inpatients'}</h2>} actions={<Button variant="ghost" size="sm" onClick={() => void refresh()}>{zh ? '刷新' : 'Refresh'}</Button>}>
    <div data-inpatient-queue className="flex flex-col gap-3"><WorkspaceModeSwitch />
      {selected ? <Button variant="outline" size="sm" onClick={() => setSelectedId(undefined)}>{zh ? '返回住院患者' : 'Back to admissions'}</Button> : null}
      {session.actor.roleCode === 'medical-records' ? <ToggleGroup aria-label={zh ? '病案整理状态' : 'Record status'} value={[recordStatus]} variant="outline" className="flex-wrap" onValueChange={values => { if (values[0]) recordView.setTab(values[0]) }}>{[['all', '全部', 'All'], ['open', '待整理', 'To prepare'], ['reviewed', '审核通过', 'Approved'], ['archived', '已归档', 'Archived']].map(([value, cn, en]) => <ToggleGroupItem key={value} value={value!}>{zh ? cn : en}</ToggleGroupItem>)}</ToggleGroup> : null}
      <div data-inpatient-queue-list>{admissions.isPending ? <Skeleton className="h-24 w-full" /> : nurse ? <InpatientNurseBench admissions={items} catalog={catalog.data} session={session} locale={locale} onSelect={setSelectedId} allowTransfers={allowTransfers} />
        : session.actor.roleCode === 'inpatient-doctor' ? <InpatientDoctorPatientList admissions={items} viewedId={selectedId ?? ''} catalog={catalog.data} virtualTime={scenario.data?.virtualTime} locale={locale} onSelect={setSelectedId} />
        : session.actor.roleCode === 'cashier' ? <>{[['待结算', 'To settle', items.filter(item => item.status === 'departed' && item.financialStatus === 'open')], ['在院', 'Admitted', items.filter(item => item.status === 'admitted' || item.status === 'discharge-pending')], ['待入科', 'Registered', items.filter(item => item.status === 'registered')], ['已结算', 'Settled', items.filter(item => item.financialStatus === 'settled' || item.status === 'cleared')]].map(([cn, en, rows]) => <section key={String(cn)} aria-label={String(zh ? cn : en)}><h3 className="text-sm font-medium">{String(zh ? cn : en)}</h3>{queueRows(rows as InpatientAdmission[])}</section>)}</>
          : queueRows(items)}</div>
      {admissions.data && items.length === 0 ? <p className="text-sm text-muted-foreground">{zh ? '暂无符合条件的住院患者；新登记的患者会在这里出现。' : 'No matching admissions. Newly registered patients appear here.'}</p> : null}
    </div>
  </WorkspaceQueueCard>
  if (insuranceOffice) return <InpatientInsuranceReview session={session} locale={locale} />
  if (selected && !registrar) return <section aria-label={zh ? '住院工作台' : 'Inpatient workspace'} className="flex min-h-0 min-w-0 flex-1 flex-col"><InpatientPatientWorkspace key={selected.id} admission={selected} admissions={admissions.data?.items ?? []} catalog={catalog.data} allowTransfers={allowTransfers} session={session} locale={locale} write={write} queue={queue} notices={notices} /></section>
  return <section aria-label={zh ? '住院工作台' : 'Inpatient workspace'} className="flex min-h-0 min-w-0 flex-1 flex-col"><WorkspaceCardLayout id={`inpatient-${session.actor.practitionerRoleId}`} locale={locale} queue={queue} flow={inpatientFlow(selected, locale)} patient={selected ? <WorkspacePatientCard title={selected.patientName} description={inpatientStatus(selected, locale)}><p className="tabular-nums">{selected.inpatientNumber} · {zh ? '预交金 ' : 'Deposits '}{formatFen(selected.depositFen, locale)}</p></WorkspacePatientCard> : undefined}
    action={registrar ? <WorkspaceActionBar tone={registrationBlocked ? 'blocked' : 'normal'}
      reason={registrationBlocked ? zh ? '请选定患者或住院证，核对病区和预交金后办理。' : 'Select a patient or referral and check the ward and deposit.' : undefined}
      action={<Button disabled={registrationBlocked} form={registrationFormId} type="submit">{zh ? '办理住院' : 'Register admission'}</Button>} /> : undefined}>
    {notices}
    {registrar ? <WorkspaceCard title={zh ? '住院登记' : 'Admission registration'}>{registrationForm}</WorkspaceCard> : <WorkspaceCard title={zh ? '从队列选择患者' : 'Select an inpatient'}><p>{zh ? '选择当前患者后，先显示本岗位有待办的环节。' : 'Selecting a patient opens the first stage with work for your role.'}</p></WorkspaceCard>}
    {nurse && allowTransfers ? <WorkspaceCard title={zh ? '待接收转科' : 'Incoming transfers'}><InpatientIncomingTransfers session={session} locale={locale} write={write} /></WorkspaceCard> : null}
    {registrar ? <WorkspaceCard title={zh ? '在册列表' : 'Registered admissions'}><Table><TableHeader><TableRow><TableHead>{zh ? '患者' : 'Patient'}</TableHead><TableHead>{zh ? '住院号' : 'Inpatient number'}</TableHead><TableHead>{zh ? '状态' : 'Status'}</TableHead></TableRow></TableHeader><TableBody>{items.map(admission => <TableRow key={admission.id}><TableCell><Button variant="link" onClick={() => setSelectedId(admission.id)}>{admission.patientName}</Button></TableCell><TableCell>{admission.inpatientNumber}</TableCell><TableCell>{inpatientStatus(admission, locale)}</TableCell></TableRow>)}</TableBody></Table></WorkspaceCard> : null}
  </WorkspaceCardLayout></section>
}
