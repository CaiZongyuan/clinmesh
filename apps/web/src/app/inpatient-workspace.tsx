import { InpatientCharges } from './inpatient-charges.tsx'
import { InpatientClinical } from './inpatient-clinical.tsx'
import type { PatientSummary, SessionContext } from '@clinmesh/contracts/his'
import { inpatientCatalogSchema, inpatientListSchema, inpatientCommandResponseSchema,
  inpatientReferralListSchema, type InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { apiGet, searchPatients } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { InpatientWriteRecovery } from './inpatient-write-recovery.tsx'

export function yuanToFen(value: string): number | undefined {
  const match = /^(\d{1,14})(?:\.(\d{1,2}))?$/.exec(value)
  if (match === null) return undefined
  const fen = BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0'))
  return fen <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(fen) : undefined
}

export function InpatientWorkspace({ session, locale }: { session: SessionContext; locale: WorkspaceLocale }): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const client = useQueryClient()
  const key = ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId]
  const catalog = useQuery({ queryKey: [...key, 'catalog'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/catalog', inpatientCatalogSchema, signal) })
  const admissions = useQuery({ queryKey: [...key, 'admissions'], queryFn: ({ signal }) => apiGet('/api/his/v1/inpatient/admissions', inpatientListSchema, signal) })
  const registrar = session.actor.roleCode === 'registrar'
  const nurse = session.actor.roleCode === 'ward-nurse'
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
  const [bedId, setBedId] = useState<string | null>(null)
  const [swapId, setSwapId] = useState<string | null>(null)
  const patients = useQuery({ queryKey: [...key, 'patients', searchTerm], enabled: registrar && searchTerm.length > 0,
    queryFn: ({ signal }) => searchPatients(searchTerm, signal) })
  const selected = admissions.data?.items.find(admission => admission.id === selectedId)
  const referral = referrals.data?.items.find(item => item.id === referralId)
  const refresh = () => client.invalidateQueries({ queryKey: ['inpatient'] })
  const write = useInpatientWriteIntent(session, async (command, response) => {
    if (command.operation === 'inpatient.admission.register') setSelectedId(inpatientCommandResponseSchema.parse(response).data.admission.id)
    await refresh()
  })
  const register = () => {
    const target = route === 'outpatient' ? referral && { id: referral.patientId, versionId: referral.patientVersion } : patient
    const amount = yuanToFen(deposit)
    if (target === undefined || wardId === null || amount === undefined) return
    write.mutation.mutate({ operation: 'inpatient.admission.register', input: {
      expectedEpoch: session.actor.epoch, patientId: target.id, patientVersion: target.versionId,
      admissionRoute: route, wardId, depositFen: amount, ...(route === 'outpatient' && referralId !== null ? { referralId } : {}),
    } })
  }
  const assignBed = (action: 'receive' | 'move-bed' | 'swap-bed') => {
    if (selected === undefined) return
    if (action === 'swap-bed') {
      const other = admissions.data?.items.find(item => item.id === swapId)
      if (other === undefined) return
      write.mutation.mutate({ operation: 'inpatient.admission.swap-bed', input: { admissionId: selected.id,
        encounterVersion: selected.versionId, otherAdmissionId: other.id, otherEncounterVersion: other.versionId } })
    } else if (bedId !== null) write.mutation.mutate({ operation: action === 'receive' ? 'inpatient.admission.receive' : 'inpatient.admission.move-bed',
      input: { admissionId: selected.id, encounterVersion: selected.versionId, bedId } })
  }
  const error = catalog.error ?? admissions.error ?? patients.error ?? referrals.error ?? write.storageFailure ?? write.mutation.error
  const messages = getWorkspaceMessages(locale)
  const status = (admission: InpatientAdmission) => ({ registered: zh ? '待入科' : 'Registered', admitted: zh ? '在院' : 'Admitted',
    'discharge-pending': zh ? '待出院' : 'Discharge pending', departed: zh ? '已出区' : 'Departed', cleared: zh ? '已清床' : 'Cleared' })[admission.status]
  const currentBed = catalog.data?.beds.find(bed => bed.id === selected?.bedId)
  return <section aria-label={zh ? '住院工作台' : 'Inpatient workspace'} className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
    {error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(error, messages)}</AlertDescription></Alert> : null}
    <InpatientWriteRecovery write={write} locale={locale} />
    {write.mutation.isSuccess && (!write.mutation.data?.command || !('admissionId' in write.mutation.data.command.input) || write.mutation.data.command.input.admissionId === selectedId) ? <p role="status">{zh ? '操作成功' : 'Operation completed'}</p> : null}
    {registrar ? <form onSubmit={event => { event.preventDefault(); register() }}>
      <FieldSet disabled={write.blocked}><FieldGroup className="grid gap-3 md:grid-cols-2">
        <Field><FieldLabel htmlFor="inpatient-route">{zh ? '入院途径' : 'Admission route'}</FieldLabel>
          <WorkspaceSelect id="inpatient-route" value={route} items={[{ value: 'direct', label: zh ? '直接入院' : 'Direct' },
            { value: 'outpatient', label: zh ? '门诊住院证转收' : 'Outpatient referral' }, { value: 'transfer', label: zh ? '转院' : 'Transfer from another hospital' }]}
            onValueChange={value => { if (value !== null) setRoute(value) }} /></Field>
        {route === 'outpatient' ? <Field><FieldLabel htmlFor="inpatient-referral">{zh ? '住院证' : 'Admission referral'}</FieldLabel>
          <WorkspaceSelect id="inpatient-referral" value={referralId} items={(referrals.data?.items ?? []).filter(item => item.status === 'issued')
            .map(item => ({ value: item.id, label: `${item.patientName} · ${item.reason}` }))} onValueChange={value => {
              setReferralId(value); setWardId(referrals.data?.items.find(item => item.id === value)?.wardId ?? null)
            }} /></Field> : <>
          <Field><FieldLabel htmlFor="inpatient-search">{zh ? '搜索住院患者' : 'Search inpatient patient'}</FieldLabel>
            <div className="flex gap-2"><Input id="inpatient-search" value={search} onChange={event => setSearch(event.currentTarget.value)} />
              <Button type="button" variant="outline" onClick={() => setSearchTerm(search.trim())}>{zh ? '搜索患者' : 'Search patients'}</Button></div></Field>
          <Field><FieldLabel htmlFor="inpatient-patient">{zh ? '住院患者' : 'Patient'}</FieldLabel>
            <WorkspaceSelect id="inpatient-patient" value={patient?.id ?? null} items={(patients.data?.items ?? []).map(item => ({ value: item.id, label: `${item.name} · ${item.identifier}` }))}
              onValueChange={value => setPatient(patients.data?.items.find(item => item.id === value))} /></Field>
        </>}
        <Field><FieldLabel htmlFor="inpatient-ward">{zh ? '入院病区' : 'Admission ward'}</FieldLabel>
          <WorkspaceSelect id="inpatient-ward" value={wardId} items={(catalog.data?.wards ?? []).map(ward => ({ value: ward.id, label: ward.name }))} onValueChange={setWardId} /></Field>
        <Field><FieldLabel htmlFor="inpatient-deposit">{zh ? '预交金（元）' : 'Deposit (CNY)'}</FieldLabel>
          <Input id="inpatient-deposit" min="0" step="0.01" type="number" value={deposit} onChange={event => setDeposit(event.currentTarget.value)} required /></Field>
        <Button disabled={write.blocked || wardId === null || (route === 'outpatient' ? referral === undefined : patient === undefined) || yuanToFen(deposit) === undefined} type="submit">{zh ? '办理住院' : 'Register admission'}</Button>
      </FieldGroup></FieldSet>
    </form> : null}
    {admissions.isPending ? <p>{zh ? '正在加载住院患者' : 'Loading admissions'}</p> : null}
    <Table><TableHeader><TableRow><TableHead>{zh ? '患者' : 'Patient'}</TableHead><TableHead>{zh ? '住院号' : 'Inpatient number'}</TableHead>
      <TableHead>{zh ? '病区 / 状态' : 'Ward / status'}</TableHead><TableHead>{zh ? '预交金 / 费用' : 'Deposit / charges'}</TableHead><TableHead>{zh ? '操作' : 'Actions'}</TableHead></TableRow></TableHeader>
      <TableBody>{admissions.data?.items.map(admission => <TableRow key={admission.id}>
        <TableCell>{admission.patientName}</TableCell><TableCell>{admission.inpatientNumber}</TableCell>
        <TableCell>{catalog.data?.wards.find(ward => ward.id === admission.wardId)?.name} · {status(admission)}</TableCell>
        <TableCell>{formatFen(admission.depositFen, locale)} / {formatFen(admission.chargesFen, locale)}</TableCell>
        <TableCell><Button aria-label={`${zh ? '查看' : 'View '}${admission.patientName}`} variant="outline" onClick={() => { setSelectedId(admission.id); setBedId(null); setSwapId(null) }}>{zh ? '查看' : 'View'}</Button></TableCell>
      </TableRow>)}</TableBody></Table>
    {admissions.data?.items.length === 0 ? <p>{zh ? '暂无住院患者' : 'No admissions'}</p> : null}
    {selected ? <section aria-label={zh ? '住院详情' : 'Admission details'} className="rounded-lg border p-4">
      <h3 className="font-semibold">{selected.patientName} · {status(selected)}</h3>
      <p>{zh ? '当前床位：' : 'Current bed: '}{currentBed?.name ?? (zh ? '未分床' : 'Unassigned')}</p>
      {nurse ? <FieldSet disabled={write.blocked}><FieldGroup className="mt-3 grid gap-3 md:grid-cols-2">
        <Field><FieldLabel htmlFor="inpatient-bed">{zh ? '目标床位' : 'Target bed'}</FieldLabel>
          <WorkspaceSelect id="inpatient-bed" value={bedId} items={(catalog.data?.beds ?? []).filter(bed => bed.wardId === selected.wardId && bed.admissionId === undefined)
            .map(bed => ({ value: bed.id, label: `${bed.name} · ${formatFen(bed.dailyPriceFen, locale)}/${zh ? '日' : 'day'}` }))} onValueChange={setBedId} /></Field>
        <Button disabled={write.blocked || bedId === null || !['registered', 'admitted'].includes(selected.status)} onClick={() => assignBed(selected.status === 'registered' ? 'receive' : 'move-bed')}>
          {selected.status === 'registered' ? (zh ? '接诊并分床' : 'Receive and assign bed') : (zh ? '转床' : 'Move bed')}</Button>
        {selected.status === 'admitted' ? <>
          <Field><FieldLabel htmlFor="inpatient-swap">{zh ? '换床患者' : 'Swap with'}</FieldLabel>
            <WorkspaceSelect id="inpatient-swap" value={swapId} items={(admissions.data?.items ?? []).filter(item => item.id !== selected.id && item.wardId === selected.wardId && item.status === 'admitted')
              .map(item => ({ value: item.id, label: `${item.patientName} · ${catalog.data?.beds.find(bed => bed.id === item.bedId)?.name}` }))} onValueChange={setSwapId} /></Field>
          <Button disabled={write.blocked || swapId === null} onClick={() => assignBed('swap-bed')}>{zh ? '互换床位' : 'Swap beds'}</Button>
        </> : null}
      </FieldGroup></FieldSet> : null}
      {session.actor.roleCode === 'cashier' ? <InpatientCharges key={selected.id} admissionId={selected.id} session={session} locale={locale} write={write} /> : !registrar ? <InpatientClinical key={selected.id} admission={selected} session={session} locale={locale} write={write} /> : null}
    </section> : null}
  </section>
}
