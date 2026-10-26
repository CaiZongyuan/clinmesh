import { InpatientPatientWorkspace, inpatientStatus } from './inpatient-patient-workspace.tsx'
import { InpatientNurseBench } from './inpatient-nurse-bench.tsx'
import { InpatientInsuranceReview } from './inpatient-insurance-review.tsx'
import { inpatientTransferCatalogSchema } from '@clinmesh/contracts/inpatient-transfer'
import { InpatientIncomingTransfers } from './inpatient-transfers.tsx'
import type { PatientSummary, SessionContext } from '@clinmesh/contracts/his'
import { inpatientCatalogSchema, inpatientListSchema, inpatientCommandResponseSchema,
  inpatientReferralListSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftIcon } from 'lucide-react'
import { useRef, useState } from 'react'
import { apiGet, searchPatients } from './api-client.ts'
import { useInpatientPaperTheme } from './inpatient-paper-theme.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen, yuanToFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'

export { yuanToFen } from './workspace-format.ts'

export function InpatientWorkspace({ session, locale }: { session: SessionContext; locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const shellRef = useRef<HTMLElement>(null)
  useInpatientPaperTheme(shellRef)
  const client = useQueryClient()
  const key = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const catalog = useQuery({ queryKey: [...key, 'catalog'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/catalog', inpatientCatalogSchema, signal) })
  const admissions = useQuery({ queryKey: [...key, 'admissions'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema, signal) })
  const registrar = session.actor.roleCode === 'registrar'
  const nurse = session.actor.roleCode === 'ward-nurse'
  const transferCatalog = useQuery({ queryKey: [...key, 'transfer-catalog'], enabled: nurse || session.actor.roleCode === 'inpatient-doctor',
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/transfer-catalog', inpatientTransferCatalogSchema, signal) })
  const allowTransfers = (transferCatalog.data?.wards.length ?? 0) > 1
  const referrals = useQuery({ queryKey: [...key, 'referrals'], enabled: registrar,
    queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/referrals', inpatientReferralListSchema, signal) })
  const [search, setSearch] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [patient, setPatient] = useState<PatientSummary>()
  const [route, setRoute] = useState<'direct' | 'outpatient' | 'transfer'>('direct')
  const [referralId, setReferralId] = useState<string | null>(null)
  const [wardId, setWardId] = useState<string | null>(null)
  const [deposit, setDeposit] = useState('0.00')
  const [selectedId, setSelectedId] = useState<string>()
  const patients = useQuery({ queryKey: [...key, 'patients', searchTerm], enabled: registrar && searchTerm.length > 0,
    queryFn: ({ signal }) => searchPatients(searchTerm, signal) })
  const selected = admissions.data?.items.find(admission => admission.id === selectedId)
  const referral = referrals.data?.items.find(item => item.id === referralId)
  const availableWards = (catalog.data?.wards ?? []).filter(ward => ward.acceptingAdmissions !== false)
  const receivingWardId = route === 'outpatient' ? referral?.wardId ?? null : wardId ?? (availableWards.length === 1 ? availableWards[0]!.id : null)
  const receivingWard = catalog.data?.wards.find(ward => ward.id === receivingWardId)
  const refresh = () => client.invalidateQueries({ queryKey: ['inpatient'] })
  const write = useInpatientWriteIntent(session, async (command, response) => {
    if (command.operation === 'inpatient.admission.register') setSelectedId(inpatientCommandResponseSchema.parse(response).data.admission.id)
    await refresh()
  })
  const register = () => {
    const target = route === 'outpatient' ? referral && { id: referral.patientId, versionId: referral.patientVersion } : patient
    const amount = yuanToFen(deposit)
    if (target === undefined || receivingWardId === null || amount === undefined) return
    write.mutation.mutate({ operation: 'inpatient.admission.register', input: {
      expectedEpoch: session.actor.epoch, patientId: target.id, patientVersion: target.versionId,
      admissionRoute: route, wardId: receivingWardId, depositFen: amount, ...(route === 'outpatient' && referralId !== null ? { referralId } : {}),
    } })
  }
  const error = catalog.error ?? transferCatalog.error ?? admissions.error ?? patients.error ?? referrals.error ?? write.storageFailure ?? write.mutation.error
  const messages = getWorkspaceMessages(locale)
  const status = (admission: InpatientAdmission) => inpatientStatus(admission, locale)
  if (session.actor.roleCode === 'medical-insurance') {
    return <section ref={shellRef} aria-label={zh ? '医保办核定工作台' : 'Insurance review workspace'} className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
      <InpatientInsuranceReview session={session} locale={locale} />
    </section>
  }
  return <section ref={shellRef} aria-label={zh ? '住院工作台' : 'Inpatient workspace'} className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <div className="shrink-0 px-4">
    {error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error, messages)}</AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
    {write.mutation.isSuccess && (!write.mutation.data?.command || !('admissionId' in write.mutation.data.command.input) || write.mutation.data.command.input.admissionId === selectedId) ? <p role="status">{zh ? '操作成功' : 'Operation completed'}</p> : null}
    </div>
    {selected ? <><div className="flex shrink-0 items-center gap-2 border-b px-4 py-2"><Button aria-label={zh ? '返回住院患者' : 'Back to admissions'} size="icon-sm" variant="ghost" onClick={() => { setSelectedId(undefined) }}><ArrowLeftIcon aria-hidden /></Button><Field orientation="horizontal" className="w-auto min-w-0 flex-1"><FieldLabel className="sr-only" htmlFor="inpatient-switch">{zh ? '切换住院患者' : 'Switch patient'}</FieldLabel><WorkspaceSelect id="inpatient-switch" value={selectedId ?? null} items={(admissions.data?.items ?? []).map(item => ({ value: item.id, label: item.patientName }))} onValueChange={value => { if (value) setSelectedId(value) }} /></Field></div><InpatientPatientWorkspace key={selected.id} admission={selected} admissions={admissions.data?.items ?? []} catalog={catalog.data} allowTransfers={allowTransfers} session={session} locale={locale} write={write} /></> : <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
    {registrar ? <form onSubmit={event => { event.preventDefault(); register() }}>
      <FieldSet disabled={write.blocked}><FieldGroup className="grid gap-3 md:grid-cols-2">
        <Field><FieldLabel htmlFor="inpatient-route">{zh ? '入院途径' : 'Admission route'}</FieldLabel>
          <WorkspaceSelect id="inpatient-route" value={route} items={[{ value: 'direct', label: zh ? '直接入院' : 'Direct' },
            { value: 'outpatient', label: zh ? '门诊住院证转收' : 'Outpatient referral' }, { value: 'transfer', label: zh ? '转院' : 'Transfer from another hospital' }]}
            onValueChange={value => { if (value !== null) setRoute(value) }} /></Field>
        {route === 'outpatient' ? <Field><FieldLabel htmlFor="inpatient-referral">{zh ? '住院证' : 'Admission referral'}</FieldLabel>
          <WorkspaceSelect id="inpatient-referral" value={referralId} items={(referrals.data?.items ?? []).filter(item => item.status === 'issued')
            .map(item => ({ value: item.id, label: `${item.patientName} · ${item.reason}` }))} onValueChange={value => {
              setReferralId(value)
            }} /></Field> : <>
          <Field><FieldLabel htmlFor="inpatient-search">{zh ? '搜索住院患者' : 'Search inpatient patient'}</FieldLabel>
            <div className="flex gap-2"><Input id="inpatient-search" value={search} onChange={event => setSearch(event.currentTarget.value)} />
              <Button type="button" variant="outline" onClick={() => setSearchTerm(search.trim())}>{zh ? '搜索患者' : 'Search patients'}</Button></div></Field>
          <Field><FieldLabel htmlFor="inpatient-patient">{zh ? '住院患者' : 'Patient'}</FieldLabel>
            <WorkspaceSelect id="inpatient-patient" value={patient?.id ?? null} items={(patients.data?.items ?? []).map(item => ({ value: item.id, label: `${item.name} · ${item.identifier}` }))}
              onValueChange={value => setPatient(patients.data?.items.find(item => item.id === value))} /></Field>
        </>}
        <Field><FieldLabel htmlFor="inpatient-ward">{zh ? '入院病区' : 'Admission ward'}</FieldLabel>
          {route === 'outpatient' || availableWards.length === 1 ? <Input id="inpatient-ward" readOnly value={receivingWard?.name ?? ''} /> : <WorkspaceSelect id="inpatient-ward" value={receivingWardId} items={availableWards.map(ward => ({ value: ward.id, label: ward.name }))} onValueChange={setWardId} />}</Field>
        <Field><FieldLabel htmlFor="inpatient-deposit">{zh ? '预交金（元）' : 'Deposit (CNY)'}</FieldLabel>
          <Input id="inpatient-deposit" min="0" step="0.01" type="number" value={deposit} onChange={event => setDeposit(event.currentTarget.value)} required /></Field>
        <Button disabled={write.blocked || receivingWardId === null || (route === 'outpatient' ? referral === undefined : patient === undefined) || yuanToFen(deposit) === undefined} type="submit">{zh ? '办理住院' : 'Register admission'}</Button>
      </FieldGroup></FieldSet>
    </form> : null}
    {nurse && allowTransfers ?<InpatientIncomingTransfers session={session} locale={locale} write={write}/>:null}
    {admissions.isPending ? <p>{zh ? '正在加载住院患者' : 'Loading admissions'}</p> : null}
    {nurse
      ? <InpatientNurseBench admissions={admissions.data?.items ?? []} catalog={catalog.data} session={session} locale={locale} onSelect={setSelectedId} />
      : <Table><TableHeader><TableRow><TableHead>{zh ? '患者' : 'Patient'}</TableHead><TableHead>{zh ? '住院号' : 'Inpatient number'}</TableHead>
      <TableHead>{zh ? '病区 / 状态' : 'Ward / status'}</TableHead><TableHead>{zh ? '预交金 / 费用' : 'Deposit / charges'}</TableHead><TableHead>{zh ? '操作' : 'Actions'}</TableHead></TableRow></TableHeader>
      <TableBody>{admissions.data?.items.map(admission => <TableRow key={admission.id}>
        <TableCell>{admission.patientName}</TableCell><TableCell>{admission.inpatientNumber}</TableCell>
        <TableCell>{catalog.data?.wards.find(ward => ward.id === admission.wardId)?.name} · {status(admission)}</TableCell>
        <TableCell>{formatFen(admission.depositFen, locale)} / {formatFen(admission.chargesFen, locale)}</TableCell>
        <TableCell><Button aria-label={`${zh ? '查看' : 'View '}${admission.patientName}`} variant="outline" onClick={() => { setSelectedId(admission.id) }}>{zh ? '查看' : 'View'}</Button></TableCell>
      </TableRow>)}</TableBody></Table>}
    {admissions.data?.items.length === 0 ? <p>{zh ? '暂无住院患者' : 'No admissions'}</p> : null}
    </div>}
  </section>
}
