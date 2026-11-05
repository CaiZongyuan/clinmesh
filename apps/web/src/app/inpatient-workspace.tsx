import { patientAge } from './doctor/patient-summary.tsx'
import { inpatientOrderRejection } from './inpatient-clinical.tsx'
import { InpatientPatientHeader, InpatientQueueGroup } from './inpatient-layout.tsx'
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
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { apiGet, getSyntheticCasesAwaitingRegistration, searchPatients } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen, formatShanghaiMinute, yuanToFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { isInpatientDraftSave, useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'
import { WorkspaceModeSwitch } from './workspace-mode.tsx'
import { WorkspaceCardLayout, WorkspaceCard, WorkspaceQueueCard, WorkspaceActionBar, WorkspaceSubmittingProvider, announceHandoff, useWorkspaceCardView } from './workspace-card-layout.tsx'
import { inpatientFlow } from './inpatient-stage-activity.ts'
import { InpatientNumber, InpatientNumberTail } from './inpatient-number.tsx'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { ArrowLeftIcon, ChevronDownIcon, RefreshCwIcon } from 'lucide-react'

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
  const scenario = useQuery({ queryKey: ['scenario', 'virtual-time'], enabled: registrar || session.actor.roleCode === 'inpatient-doctor',
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
  const [deposit, setDeposit] = useState('2000.00')
  const [selectedId, setSelectedId] = useState<string>()
  const fromCase = route === 'direct' && source === 'synthetic'
  const cases = useQuery({ queryKey: [...key, 'synthetic-cases', casePage], enabled: registrar && fromCase,
    queryFn: ({ signal }) => getSyntheticCasesAwaitingRegistration(signal, casePage) })
  const selectedCase = cases.data?.items.find(item => item.caseId === caseId)
  const patients = useQuery({ queryKey: [...key, 'patients', searchTerm], enabled: registrar && searchTerm.length > 0,
    queryFn: ({ signal }) => searchPatients(searchTerm, signal) })
  useEffect(() => {
    if (patients.data?.items.length === 1 && !patient) setPatient(patients.data.items[0])
  }, [patients.data, patient])
  const selected = admissions.data?.items.find(admission => admission.id === selectedId)
  const issuedReferrals = (referrals.data?.items ?? []).filter(item => item.status === 'issued')
  const referral = referrals.data?.items.find(item => item.id === referralId) ?? (route === 'outpatient' ? issuedReferrals[0] : undefined)
  const availableWards = (catalog.data?.wards ?? []).filter(ward => ward.acceptingAdmissions !== false)
  const receivingWardId = route === 'outpatient' ? wardId ?? referral?.wardId ?? null : wardId ?? (availableWards.length === 1 ? availableWards[0]!.id : null)
  const receivingWard = catalog.data?.wards.find(ward => ward.id === receivingWardId)
  const refresh = () => Promise.all([client.invalidateQueries({ queryKey: ['inpatient'] }), client.invalidateQueries({ queryKey: ['scenario', 'virtual-time'] })])
  const write = useInpatientWriteIntent(session, async (command, response) => {
    const handedTo = zh ? '已交给病区护士接诊并分床' : 'Handed to the ward nurse to receive and assign a bed'
    if (command.operation === 'inpatient.admission.register') {
      const { admission } = inpatientCommandResponseSchema.parse(response).data
      setSelectedId(admission.id)
      announceHandoff(`${zh ? '已完成住院登记' : 'Admission registered'} · ${admission.patientName}`, handedTo)
    }
    if (command.operation === 'registration.synthetic-case.start-inpatient') {
      setSelectedId(startSyntheticInpatientCaseResponseSchema.parse(response).data.admissionId)
      announceHandoff(zh ? '已完成住院登记' : 'Admission registered', handedTo)
    }
    await refresh()
  })
  const registrationResult = write.mutation.isSuccess ? write.mutation.data : undefined
  const registeredAdmissionId = registrationResult?.command.operation === 'inpatient.admission.register'
    ? inpatientCommandResponseSchema.parse(registrationResult.response).data.admission.id
    : registrationResult?.command.operation === 'registration.synthetic-case.start-inpatient'
      ? startSyntheticInpatientCaseResponseSchema.parse(registrationResult.response).data.admissionId : undefined
  const registrationComplete = (registeredAdmissionId !== undefined && registeredAdmissionId === selectedId) || Boolean(registrar && selected)
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
      admissionRoute: route, wardId: receivingWardId, depositFen: amount, ...(route === 'outpatient' && referral ? { referralId: referral.id } : {}),
    } })
  }
  const error = catalog.error ?? transferCatalog.error ?? admissions.error ?? scenario.error ?? patients.error ?? referrals.error ?? write.storageFailure ?? (inpatientOrderRejection(write.mutation) ? null : write.mutation.error)
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
  const allAdmissions = admissions.data?.items ?? []
  const dischargedOrReviewed = allAdmissions.filter(item => item.status === 'departed' || item.status === 'cleared' || item.recordStatus !== 'open')
  const medicalRecordsPool = session.actor.roleCode === 'medical-records' && dischargedOrReviewed.length > 0 ? dischargedOrReviewed : allAdmissions
  const items = (session.actor.roleCode === 'medical-records' ? medicalRecordsPool : allAdmissions).filter(item => session.actor.roleCode !== 'medical-records' || recordStatus === 'all' || item.recordStatus === recordStatus)
  // 审核通过或归档后筛选跟随当前病案，避免它从列表消失；人工切换筛选不受影响。
  const followed = useRef<{ id?: string | undefined; status?: string | undefined }>({}), setRecordStatus = recordView.setTab
  const selectedRecordStatus = session.actor.roleCode === 'medical-records' ? selected?.recordStatus : undefined
  useEffect(() => {
    const previous = followed.current
    followed.current = { id: selectedId, status: selectedRecordStatus }
    if (previous.id === selectedId && previous.status !== undefined && selectedRecordStatus !== undefined && previous.status !== selectedRecordStatus
      && recordStatus !== 'all') setRecordStatus(selectedRecordStatus)
  }, [selectedId, selectedRecordStatus, recordStatus, setRecordStatus])
  const registrationFormId = `${session.actor.practitionerRoleId}-admission-form`
  const registrationBlocked = write.blocked || receivingWardId === null || (fromCase ? selectedCase === undefined || cases.isFetching : (route === 'outpatient' ? referral === undefined : patient === undefined) || yuanToFen(deposit) === undefined)
  const registrationForm = registrar ? <form id={registrationFormId} onSubmit={event => { event.preventDefault(); register() }}>
      <FieldSet disabled={write.blocked}><FieldGroup className="grid gap-3 md:grid-cols-3">
        <Field className="md:col-span-3"><FieldLabel htmlFor="inpatient-route">{zh ? '入院途径' : 'Admission route'}</FieldLabel>
          <ToggleGroup id="inpatient-route" aria-label={zh ? '入院途径' : 'Admission route'} value={[route]} variant="outline" data-view-switch="" className="flex-wrap" onValueChange={values => { const value = values[0]; if (value === 'direct' || value === 'outpatient' || value === 'transfer') { setRoute(value); setWardId(null) } }}>
            <ToggleGroupItem value="outpatient">{zh ? '门诊住院证转收' : 'Outpatient referral'}</ToggleGroupItem><ToggleGroupItem value="direct">{zh ? '直接入院' : 'Direct'}</ToggleGroupItem><ToggleGroupItem value="transfer">{zh ? '转院' : 'Transfer from another hospital'}</ToggleGroupItem>
          </ToggleGroup></Field>
        {route === 'outpatient' ? <Field className="md:col-span-3">
          {!referral && issuedReferrals.length > 0 ? <><FieldLabel htmlFor="inpatient-referral">{zh ? '住院证' : 'Admission referral'}</FieldLabel>
            <WorkspaceSelect id="inpatient-referral" value={referralId} items={issuedReferrals
              .map(item => ({ value: item.id, label: `${item.patientName} · ${item.reason}` }))} onValueChange={value => {
                setReferralId(value)
              }} /></> : null}
          {referral ? <section aria-label={zh ? '住院证内容' : 'Referral details'} className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-xs font-semibold">{zh ? '住院证' : 'Admission referral'} · {referral.patientName}</strong>
                <span className="text-xs text-muted-foreground">{zh ? '来自门诊医生' : 'From outpatient doctor'}</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <div><div className="text-xs text-muted-foreground">{zh ? '开证科室 / 医生' : 'Department / Doctor'}</div><div className="font-semibold">{`${referral.issuingDepartment ?? (zh ? '心内科门诊' : 'Cardiology')}${referral.issuingDoctorName ? ` · ${referral.issuingDoctorName}` : ''}`}</div></div>
                <div><div className="text-xs text-muted-foreground">{zh ? '收治病区' : 'Receiving ward'}</div><div className="font-semibold">{receivingWard?.name ?? '—'}</div></div>
                <div><div className="text-xs text-muted-foreground">{zh ? '开证时间' : 'Issued at'}</div><div className="font-semibold tabular-nums">{formatShanghaiMinute(referral.issuedAt).slice(5)}</div></div>
                <div><div className="text-xs text-muted-foreground">{zh ? '住院原因' : 'Reason'}</div><div className="font-semibold">{referral.reason}</div></div>
              </div>
            </section> : <p className="text-sm text-muted-foreground">{zh ? '当前暂无待转收的门诊住院证，可在左侧队列选择或切换为直接入院。' : 'No pending outpatient referrals. Select one from the queue or switch to direct admission.'}</p>}
        </Field> : fromCase ? <Field className="md:col-span-3">
          <FieldLabel htmlFor="inpatient-synthetic-case">{zh ? '待住院合成病例' : 'Synthetic case for admission'}</FieldLabel>
          <WorkspaceSelect id="inpatient-synthetic-case" value={selectedCase?.caseId ?? null}
            items={(cases.data?.items ?? []).map(item => ({ value: item.caseId, label: `${item.name} · ${item.mrn}` }))} onValueChange={setCaseId} />
          {cases.isPending ? <p role="status">{zh ? '正在加载就绪病例' : 'Loading ready cases'}</p> : null}
          {cases.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(cases.error, messages)}</AlertDescription></Alert> : null}
          {cases.data?.total === 0 ? <FieldDescription>{zh ? '暂无就绪病例，请管理员准备病例及有效患者档案。固定 PCI 病例准备后可直接选用。' : 'No ready cases. Ask an administrator to prepare a case with an active patient persona. Fixed PCI preparation selects the persona automatically.'}</FieldDescription> : null}
          {selectedCase ? <FieldDescription>{zh ? '患者档案修订' : 'Patient profile revision'} {selectedCase.profileRevision} · {zh ? '患者自述修订' : 'Patient statement revision'} {selectedCase.activeBriefRevision}</FieldDescription> : null}
          <FieldDescription>{zh ? '直接入院后由病区护士接诊；预交金在独立资金流程办理。' : 'The ward nurse receives the admission. Collect deposits through the separate payment workflow.'}</FieldDescription>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" disabled={cases.isFetching} onClick={() => { setCaseId(null); void cases.refetch() }}>{zh ? '刷新就绪病例' : 'Refresh ready cases'}</Button>
            <Button type="button" variant="outline" disabled={casePage === 1 || cases.isFetching} onClick={() => { setCaseId(null); setCasePage(value => value - 1) }}>{zh ? '上一页' : 'Previous'}</Button>
            <Button type="button" variant="outline" disabled={cases.data === undefined || casePage * cases.data.pageSize >= cases.data.total || cases.isFetching} onClick={() => { setCaseId(null); setCasePage(value => value + 1) }}>{zh ? '下一页' : 'Next'}</Button>
          </div>
        </Field> : <>
          <Field className="md:col-span-2"><FieldLabel htmlFor="inpatient-search">{zh ? '搜索住院患者' : 'Search inpatient patient'}</FieldLabel>
            <div className="flex gap-2"><Input id="inpatient-search" placeholder={zh ? '输入姓名或病历号' : 'Enter name or MRN'} value={search} onChange={event => { const v = event.currentTarget.value; setSearch(v); setSearchTerm(v.trim()) }} />
              <Button type="button" variant="outline" onClick={() => setSearchTerm(search.trim())}>{zh ? '搜索患者' : 'Search patients'}</Button></div>
            <FieldDescription>{zh ? '找不到时先在挂号处建档，再回来登记。' : 'If not found, create a patient record at registration first.'}</FieldDescription></Field>
          <Field><FieldLabel htmlFor="inpatient-patient">{zh ? '住院患者' : 'Patient'}</FieldLabel>
            <WorkspaceSelect id="inpatient-patient" value={patient?.id ?? null} items={(patients.data?.items ?? []).map(item => ({ value: item.id, label: `${item.name} · ${item.identifier}` }))}
              onValueChange={value => setPatient(patients.data?.items.find(item => item.id === value))} /></Field>
        </>}
        <Field><FieldLabel htmlFor="inpatient-ward">{zh ? '入院病区' : 'Admission ward'}</FieldLabel>
          {route === 'outpatient' || availableWards.length === 1 ? <div className="relative"><Input id="inpatient-ward" readOnly value={receivingWard?.name ?? ''} className="pr-8" /><ChevronDownIcon aria-hidden="true" className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /></div> : <WorkspaceSelect id="inpatient-ward" value={receivingWardId} items={availableWards.map(ward => ({ value: ward.id, label: ward.name }))} onValueChange={setWardId} />}
          {route === 'outpatient' ? <FieldDescription>{zh ? '默认取住院证上的收治病区' : 'Defaults to the ward on the referral'}</FieldDescription> : null}</Field>
        {route === 'direct' ? <Field><FieldLabel htmlFor="inpatient-source">{zh ? '患者来源' : 'Patient source'}</FieldLabel>
          <WorkspaceSelect id="inpatient-source" value={source} items={[{ value: 'patient', label: zh ? '已有患者' : 'Existing patient' },
            { value: 'synthetic', label: zh ? '就绪合成病例' : 'Ready synthetic case' }]} onValueChange={value => { if (value !== null) setSource(value) }} /></Field> : null}
        {route === 'outpatient' || route === 'transfer' ? <Field><FieldLabel htmlFor="inpatient-source">{zh ? '患者来源' : 'Patient source'}</FieldLabel><WorkspaceSelect id="inpatient-source" disabled value={route} items={[{ value: 'outpatient', label: zh ? '门诊住院证转收' : 'Outpatient referral' }, { value: 'transfer', label: zh ? '转院患者' : 'Transferred patient' }]} onValueChange={() => undefined} /></Field> : null}
        {fromCase ? null : <Field><FieldLabel htmlFor="inpatient-deposit">{zh ? '预交金（元）' : 'Deposit (CNY)'}</FieldLabel>
          <Input id="inpatient-deposit" min="0" step="0.01" type="number" value={deposit} onChange={event => setDeposit(event.currentTarget.value)} required />
          <FieldDescription>{zh ? '按现金记录；其他方式在住院收费办理' : 'Recorded as cash; other methods are handled at inpatient cashier'}</FieldDescription></Field>}
      </FieldGroup></FieldSet>
    </form> : null
  const notices = <>
    {error ? <Alert variant="destructive"><AlertDescription>{errorLabel}{getWorkspaceErrorMessage(error, messages)} <Button variant="outline" size="sm" onClick={() => { void refresh(); void catalog.refetch() }}>{zh ? '重试读取' : 'Retry loading'}</Button></AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
  </>
  // registeredAt 取自场景虚拟时钟，「今日」按虚拟时间的上海日期判断；时钟未读到时列出全部登记。
  const shanghaiDay = (value: string) => new Date(value).toLocaleDateString('sv', { timeZone: 'Asia/Shanghai' })
  const virtualDay = scenario.data ? shanghaiDay(scenario.data.virtualTime) : undefined
  const registered = virtualDay ? items.filter(item => shanghaiDay(item.registeredAt) === virtualDay) : items
  const registeredLabel = virtualDay ? zh ? '今日已登记' : 'Registered today' : zh ? '已登记' : 'Registered'
  const queueRows = (rows: InpatientAdmission[]) => <div data-inpatient-queue-items>{rows.map(admission => {
    const wardName = catalog.data?.wards.find(ward => ward.id === admission.wardId)?.name
    const bedName = catalog.data?.beds.find(bed => bed.id === (admission.bedId ?? admission.lastBedId))?.name
    const isCashier = session.actor.roleCode === 'cashier'
    const isMedicalRecords = session.actor.roleCode === 'medical-records'
    return <Button key={admission.id} variant="ghost" className="h-auto w-full justify-start whitespace-normal px-2 py-2.5 text-start" aria-current={selectedId === admission.id ? 'true' : undefined}
      aria-label={`${zh ? '查看' : 'View '}${admission.patientName}`} onClick={() => setSelectedId(admission.id)}>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <strong>{admission.patientName}</strong>
          {isMedicalRecords ? <Badge variant={admission.recordStatus === 'open' ? 'warning' : admission.recordStatus === 'reviewed' ? 'success' : 'outline'}>{{ open: zh ? '待整理' : 'To prepare', reviewed: zh ? '审核通过' : 'Approved', archived: zh ? '已归档' : 'Archived' }[admission.recordStatus]}</Badge>
            : isCashier ? (admission.status === 'departed' && admission.financialStatus === 'open'
              ? <Badge variant="warning">{(admission.outstandingFen ?? 0) > 0 ? (zh ? '需补交' : 'Supplement') : (zh ? '结算' : 'Settle')}</Badge>
              : (admission.financialStatus === 'settled' || admission.status === 'cleared')
                ? <Badge variant="success">{zh ? '已结算' : 'Settled'}</Badge>
                : <span className="text-xs text-muted-foreground tabular-nums">{formatFen(admission.chargesFen, locale)}</span>)
            : registrar ? <Badge variant={admission.status === 'registered' ? 'outline' : 'secondary'}>{inpatientStatus(admission, locale)}</Badge> : null}
        </span>
        <span className="text-xs text-muted-foreground">
          {isMedicalRecords
            ? <>{wardName} · {admission.departedAt ? `${formatShanghaiMinute(admission.departedAt).slice(5, 10)} ${zh ? '出院' : 'discharged'}` : inpatientStatus(admission, locale)}</>
            : isCashier
              ? <>{bedName ?? wardName} · {inpatientStatus(admission, locale)}{admission.status === 'departed' && admission.financialStatus === 'open' && (admission.outstandingFen ?? 0) > 0 ? ` · ${zh ? '需补交 ' : 'Amount due '}${formatFen(admission.outstandingFen!, locale)}` : (admission.status === 'admitted' || admission.status === 'discharge-pending') ? ` · ${zh ? '预交金 ' : 'Deposit '}${formatFen(admission.depositFen, locale)}` : ''}</>
              : <>{wardName} {bedName} · {inpatientStatus(admission, locale)} · <InpatientNumberTail locale={locale} number={admission.inpatientNumber} /></>}
        </span>
      </span>
    </Button>
  })}</div>
  const queueCount = session.actor.roleCode === 'medical-records' ? medicalRecordsPool.length : (!registrar && !nurse && !insuranceOffice ? items.length : undefined)
  const showBackToQueue = selected && !registrar && session.actor.roleCode !== 'cashier' && session.actor.roleCode !== 'medical-records'
  const queue = <WorkspaceQueueCard title={<h2>{nurse ? zh ? '本病区' : 'My ward' : session.actor.roleCode === 'medical-records' ? zh ? '病案队列' : 'Medical records queue' : zh ? '住院患者' : 'Inpatients'}</h2>} actions={<>{queueCount !== undefined ? <Badge variant="secondary" className="tabular-nums">{queueCount}</Badge> : null}{showBackToQueue ? <Button variant="ghost" size="icon-sm" aria-label={zh ? '返回住院患者' : 'Back to admissions'} title={zh ? '返回住院患者' : 'Back to admissions'} onClick={() => setSelectedId(undefined)}><ArrowLeftIcon aria-hidden="true" /></Button> : null}<Button variant="ghost" size="icon-sm" aria-label={zh ? '刷新' : 'Refresh'} title={zh ? '刷新' : 'Refresh'} onClick={() => void refresh()}><RefreshCwIcon aria-hidden="true" /></Button></>}>
    <div className={nurse ? "clinmesh-inpatient-nurse-queue-body flex min-h-0 flex-1 flex-col gap-3" : "flex flex-col gap-3"}><WorkspaceModeSwitch />
      {session.actor.roleCode === 'medical-records' ? <ToggleGroup aria-label={zh ? '病案整理状态' : 'Record status'} value={[recordStatus]} variant="outline" className="flex w-full flex-wrap gap-1" data-view-switch="" onValueChange={values => { if (values[0]) recordView.setTab(values[0]) }}>{[['all', '全部', 'All'], ['open', '待整理', 'To prepare'], ['reviewed', '审核通过', 'Approved'], ['archived', '已归档', 'Archived']].map(([value, cn, en]) => {
        const count = medicalRecordsPool.filter(item => value === 'all' || item.recordStatus === value).length
        return <ToggleGroupItem key={value} value={value!} className="px-2 text-xs" aria-label={zh ? cn : en} aria-description={zh ? `${count} 份病案` : `${count} records`}>{zh ? cn : en} <span aria-hidden="true" className="tabular-nums">{count}</span></ToggleGroupItem>
      })}</ToggleGroup> : null}
      <div className={nurse ? "clinmesh-inpatient-nurse-queue-list" : undefined}>{admissions.isPending ? <Skeleton className="h-24 w-full" /> : nurse ? <InpatientNurseBench admissions={items} selectedId={selectedId} catalog={catalog.data} session={session} locale={locale} onSelect={setSelectedId} allowTransfers={allowTransfers} />
        : session.actor.roleCode === 'inpatient-doctor' ? <InpatientDoctorPatientList admissions={items} viewedId={selectedId ?? ''} catalog={catalog.data} virtualTime={scenario.data?.virtualTime} locale={locale} onSelect={setSelectedId} />
        : session.actor.roleCode === 'cashier' ? <>{[['待结算', 'To settle', items.filter(item => item.status === 'departed' && item.financialStatus === 'open')], ['在院', 'Admitted', items.filter(item => item.status === 'admitted' || item.status === 'discharge-pending')], ['待入科', 'Registered', items.filter(item => item.status === 'registered')], ['已结算', 'Settled', items.filter(item => item.financialStatus === 'settled' || item.status === 'cleared')]].map(([cn, en, rows]) => <InpatientQueueGroup key={String(cn)} title={String(zh ? cn : en)} count={(rows as InpatientAdmission[]).length}>{queueRows(rows as InpatientAdmission[])}</InpatientQueueGroup>)}</>
          : registrar ? <>
            <InpatientQueueGroup title={zh ? '门诊住院证' : 'Outpatient referrals'} count={issuedReferrals.length}>
              {issuedReferrals.length === 0 ? <p className="text-sm text-muted-foreground">{zh ? '门诊医生开具住院证后会出现在这里。' : 'Outpatient referrals appear here once issued.'}</p>
                : <div data-inpatient-queue-items>{issuedReferrals.map(item => {
                  const targetWard = catalog.data?.wards.find(w => w.id === item.wardId)?.name
                  const deptLabel = item.issuingDepartment ?? (zh ? '心内科门诊' : 'Outpatient')
                  return <Button key={item.id} variant="ghost" className="h-auto w-full justify-start whitespace-normal px-2 py-2.5 text-start"
                    aria-current={!selected && route === 'outpatient' && referral?.id === item.id ? 'true' : undefined} onClick={() => { setSelectedId(undefined); setRoute('outpatient'); setReferralId(item.id); setWardId(null) }}>
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <strong>{item.patientName}</strong>
                        <span className="text-xs text-muted-foreground tabular-nums">{formatShanghaiMinute(item.issuedAt).slice(5)}</span>
                      </span>
                      <span className="text-xs text-muted-foreground">{targetWard ? `${deptLabel} · ${zh ? '拟入 ' : ''}${targetWard} · ` : ''}{item.reason}</span>
                    </span>
                  </Button>
                })}</div>}
            </InpatientQueueGroup>
            <InpatientQueueGroup title={registeredLabel} count={registered.length}>
              {registered.length === 0 ? <p className="px-2 py-1 text-xs text-muted-foreground">{zh ? '今日尚无已登记患者' : 'No patients registered today'}</p> : queueRows(registered)}
            </InpatientQueueGroup>
          </>
          : queueRows(items)}</div>
      {admissions.data && items.length === 0 && !nurse && !registrar ? <p className="text-sm text-muted-foreground">{zh ? '暂无符合条件的住院患者；新登记的患者会在这里出现。' : 'No matching admissions. Newly registered patients appear here.'}</p> : null}
    </div>
  </WorkspaceQueueCard>
  if (insuranceOffice) return <InpatientInsuranceReview session={session} locale={locale} />
  const registrationPatient = route === 'outpatient' ? referral?.patientName : fromCase ? selectedCase?.name : patient?.name
  const registrationBirthDate = route === 'outpatient' ? referral?.patientBirthDate : patient?.birthDate
  const registrationGender = route === 'outpatient' ? referral?.patientGender : patient?.gender
  const registrationAge = registrationBirthDate && scenario.data ? patientAge(registrationBirthDate, new Date(Date.parse(scenario.data.virtualTime) + 8 * 60 * 60 * 1000)) : undefined
  const registrationIdentity = registrationGender ? `${registrationGender === 'female' ? zh ? '女' : 'Female' : registrationGender === 'male' ? zh ? '男' : 'Male' : zh ? '性别未登记' : 'Gender unavailable'}${registrationAge !== undefined ? ` · ${registrationAge}${zh ? ' 岁' : ' years'}` : ''}` : undefined
  const selectedBirthDate = selected?.patientBirthDate
  const selectedGender = selected?.patientGender
  const selectedAge = selectedBirthDate && scenario.data ? patientAge(selectedBirthDate, new Date(Date.parse(scenario.data.virtualTime) + 8 * 60 * 60 * 1000)) : undefined
  const selectedIdentity = selectedGender ? `${selectedGender === 'female' ? zh ? '女' : 'Female' : selectedGender === 'male' ? zh ? '男' : 'Male' : zh ? '性别未登记' : 'Gender unavailable'}${selectedAge !== undefined ? ` · ${selectedAge}${zh ? ' 岁' : ' years'}` : ''}` : undefined
  const submitting = write.mutation.isPending && !isInpatientDraftSave(write.pending?.command ?? write.mutation.variables)
    ? zh ? '正在提交' : 'Submitting' : undefined
  const nextReferral = issuedReferrals[0]
  if (selected && !registrar) return <WorkspaceSubmittingProvider value={submitting}><section aria-label={zh ? '住院工作台' : 'Inpatient workspace'} className="clinmesh-inpatient-workspace flex min-h-0 min-w-0 flex-1 flex-col"><InpatientPatientWorkspace key={selected.id} admission={selected} admissions={admissions.data?.items ?? []} catalog={catalog.data} allowTransfers={allowTransfers} session={session} locale={locale} write={write} queue={queue} notices={notices} /></section></WorkspaceSubmittingProvider>
  return <WorkspaceSubmittingProvider value={submitting}><section aria-label={zh ? '住院工作台' : 'Inpatient workspace'} className="clinmesh-inpatient-workspace flex min-h-0 min-w-0 flex-1 flex-col"><WorkspaceCardLayout id={`inpatient-${session.actor.practitionerRoleId}`} locale={locale} queue={queue} flow={inpatientFlow(selected, locale)} patient={selected ? <InpatientPatientHeader name={selected.patientName} identity={selectedIdentity} status={inpatientStatus(selected, locale)} location={catalog.data?.wards.find(ward => ward.id === selected.wardId)?.name} details={<><InpatientNumber locale={locale} number={selected.inpatientNumber} /><span>{zh ? '预交金 ' : 'Deposits '}{formatFen(selected.depositFen, locale)}</span><span>{zh ? '登记于 ' : 'Registered '}{formatShanghaiMinute(selected.registeredAt).slice(5)}</span></>} /> : registrar ? (registrationPatient ? <InpatientPatientHeader name={registrationPatient} status={zh ? '待登记' : 'Awaiting registration'} location={receivingWard?.name} identity={registrationIdentity} details={referral && route === 'outpatient' ? <span>{zh ? '来自门诊住院证 · ' : 'From referral · '}{referral.reason}</span> : undefined} /> : <InpatientPatientHeader name={zh ? '新患者' : 'New patient'} status={zh ? '待登记' : 'Awaiting registration'} identity={zh ? '先检索已有患者' : 'Search existing patient first'} />) : undefined}
    action={registrar && registrationComplete && selected ? <WorkspaceActionBar tone="complete"
      summary={zh ? `已完成住院登记 · ${selected.patientName} 已出现在病区护士的「新入院」` : `Admission registered · ${selected.patientName} is in the ward nurse's new admissions queue`}
      reason={zh ? '下一步：病区护士接诊并分床。' : 'Next: the ward nurse receives the patient and assigns a bed.'}
      action={<Button onClick={() => { setSelectedId(undefined); write.mutation.reset(); if (nextReferral) { setRoute('outpatient'); setReferralId(nextReferral.id); setWardId(null) } }}>{nextReferral ? (zh ? `继续登记下一位：${nextReferral.patientName} →` : `Register next: ${nextReferral.patientName} →`) : (zh ? '继续登记下一位 →' : 'Register another patient →')}</Button>} /> : registrar ? <WorkspaceActionBar tone={registrationBlocked ? 'blocked' : 'normal'}
      reason={registrationBlocked ? (zh ? (route !== 'outpatient' && !fromCase && !patient ? '还差：选择患者' : '还差：请选定患者或住院证，核对病区和预交金后办理。') : 'Select a patient or referral and check the ward and deposit.') : (zh ? '核对病区和预交金后办理' : 'Check the ward and deposit before registering')}
      action={<Button disabled={registrationBlocked} form={registrationFormId} type="submit">{zh ? '办理住院' : 'Register admission'}</Button>} /> : undefined}>
    {notices}
    {registrar ? <div className="flex flex-col gap-3">
      {registrationComplete && selected ? <>
        <div role="status" className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
          ✓ {zh ? '已完成住院登记，等病区护士接诊并分床' : 'Admission registered; awaiting ward nurse reception and bed assignment'}
        </div>
        <section aria-label={zh ? '登记摘要' : 'Registration summary'} className="grid gap-3 rounded-md border bg-muted/20 p-3 text-sm sm:grid-cols-3">
          <div><div className="text-xs text-muted-foreground">{zh ? '入院途径' : 'Route'}</div><div className="font-semibold">{selected.admissionRoute === 'outpatient' ? zh ? '门诊住院证转收' : 'Outpatient referral' : selected.admissionRoute === 'direct' ? zh ? '直接入院' : 'Direct' : zh ? '转院' : 'Transfer'}</div></div>
          <div><div className="text-xs text-muted-foreground">{zh ? '入院病区' : 'Ward'}</div><div className="font-semibold">{catalog.data?.wards.find(ward => ward.id === selected.wardId)?.name ?? '—'}</div></div>
          <div><div className="text-xs text-muted-foreground">{zh ? '预交金' : 'Deposit'}</div><div className="font-semibold tabular-nums">{formatFen(selected.depositFen, locale)}{zh ? ' · 现金' : ' · Cash'}</div></div>
          <div><div className="text-xs text-muted-foreground">{zh ? '住院号' : 'Inpatient No.'}</div><div className="font-semibold"><InpatientNumber locale={locale} number={selected.inpatientNumber} /></div></div>
          <div><div className="text-xs text-muted-foreground">{zh ? '开证科室 / 住院原因' : 'Department / Reason'}</div><div className="font-semibold">{selected.admissionRoute === 'outpatient' ? `${referral?.issuingDepartment ?? (zh ? '心内科门诊' : 'Cardiology')} · ${selected.referralReason ?? referral?.reason ?? ''}` : (selected.referralReason ?? (zh ? '直接入院' : 'Direct admission'))}</div></div>
          <div><div className="text-xs text-muted-foreground">{zh ? '登记时间' : 'Registered at'}</div><div className="font-semibold tabular-nums">{formatShanghaiMinute(selected.registeredAt).slice(5)}</div></div>
        </section>
      </> : registrationForm}
    </div> : <WorkspaceCard title={zh ? '从队列选择患者' : 'Select an inpatient'}><p>{zh ? '选择当前患者后，先显示本岗位有待办的环节。' : 'Selecting a patient opens the first stage with work for your role.'}</p></WorkspaceCard>}
    {nurse && allowTransfers ? <WorkspaceCard title={zh ? '待接收转科' : 'Incoming transfers'}><InpatientIncomingTransfers session={session} locale={locale} write={write} /></WorkspaceCard> : null}
  </WorkspaceCardLayout></section></WorkspaceSubmittingProvider>
}
