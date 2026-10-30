import type { PatientSummary, SessionContext } from '@clinmesh/contracts/his'
import type { SyntheticCaseRegistrationSummary } from '@clinmesh/contracts/scenario'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, CircleAlertIcon, ClipboardListIcon, ClipboardPlusIcon, SearchIcon, UserPlusIcon, XIcon } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import {
  createSyntheticPatient,
  getRegistrationCatalog,
  getRegistrationQueue,
  getSyntheticCasesAwaitingRegistration,
  newIdempotencyKey,
  registerOutpatient,
  searchPatients,
  startSyntheticCaseVisit,
} from './api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { RegistrationNumber } from './registration-number.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { agentViewRevision, useRegisterAgentPage } from './agent-page-context.tsx'
import { useAgentReview } from './agent-review.tsx'
import { WorkspaceModeSwitch } from './workspace-mode.tsx'
import { AgentDraftField, WorkspaceActionBar, WorkspaceCard, WorkspaceCardLayout, WorkspacePatientCard, WorkspaceQueueCard, useWorkspaceCardView } from './workspace-card-layout.tsx'
import { outpatientFlow } from './workspace-flow.ts'

interface RegistrarWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

const genderValues = ['male', 'female', 'other', 'unknown'] as const
type RegistrationMutationResult =
  | Awaited<ReturnType<typeof registerOutpatient>>
  | Awaited<ReturnType<typeof startSyntheticCaseVisit>>
type RegistrationSelection =
  | { kind: 'patient'; patient: PatientSummary }
  | { kind: 'synthetic-case'; syntheticCase: SyntheticCaseRegistrationSummary }
type PatientDraft = Parameters<typeof createSyntheticPatient>[0]
type PatientSubmission = { input: PatientDraft; selectionKey: string }
type RegistrationSubmission =
  | { kind: 'patient'; input: Parameters<typeof registerOutpatient>[0]; selectionKey: string }
  | { kind: 'synthetic-case'; input: Parameters<typeof startSyntheticCaseVisit>[0]; selectionKey: string }
type DraftField = keyof PatientDraft | 'departmentId' | 'locationId' | 'visitTypeId'
type RegistrarDraft = PatientDraft & { departmentId: string; locationId: string; visitTypeId: string; assisted: readonly DraftField[] }
const defaultDraft: RegistrarDraft = { name: '', identifier: '', birthDate: '1990-01-01', gender: 'male', departmentId: '', locationId: '', visitTypeId: '', assisted: [] }
const hospitalDateFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
function hospitalDate(value: string) { return hospitalDateFormatter.format(new Date(value)) }

export function RegistrarWorkspace({ locale, session }: RegistrarWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const text = (zh: string, en: string) => locale === 'zh-CN' ? zh : en
  const agentReview = useAgentReview()
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const [patientQuery, setPatientQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [patientPage, setPatientPage] = useState(1)
  const [caseQuery, setCaseQuery] = useState('')
  const [submittedCaseQuery, setSubmittedCaseQuery] = useState('')
  const [casePage, setCasePage] = useState(1)
  const [registrationPage, setRegistrationPage] = useState(1)
  const [selection, setSelection] = useState<RegistrationSelection>()
  const [drafts, setDrafts] = useState<Record<string, RegistrarDraft>>({})
  const queueView = useWorkspaceCardView('registration-queue')
  const layoutView = useWorkspaceCardView('registration-workspace')
  const queueTab = queueView.tab === 'search' || queueView.tab === 'create' ? queueView.tab : 'cases'
  const recordView = useWorkspaceCardView('registration-record-period')
  const recordPeriod = recordView.tab === 'all' ? 'all' : 'today'
  const selectionKey = JSON.stringify([session.user.id, session.actor, selection?.kind,
    selection?.kind === 'patient' ? selection.patient.id : selection?.syntheticCase.caseId])
  const draft = drafts[selectionKey] ?? defaultDraft
  const { name, identifier, birthDate, gender, departmentId, locationId, visitTypeId } = draft
  function setField<Field extends DraftField>(field: Field, value: RegistrarDraft[Field]) {
    setDrafts(current => ({ ...current, [selectionKey]: { ...(current[selectionKey] ?? defaultDraft), [field]: value } }))
  }
  const setName = (value: string) => setField('name', value)
  const setIdentifier = (value: string) => setField('identifier', value)
  const setBirthDate = (value: string) => setField('birthDate', value)
  const setGender = (value: PatientDraft['gender']) => setField('gender', value)
  const setDepartmentId = (value: string) => setField('departmentId', value)
  const setLocationId = (value: string) => setField('locationId', value)
  const setVisitTypeId = (value: string) => setField('visitTypeId', value)
  const patientDraft: PatientDraft = { birthDate, gender, identifier, name }
  const latestPatientDraft = useRef(patientDraft)
  latestPatientDraft.current = patientDraft
  const latestSelectionKey = useRef(selectionKey)
  latestSelectionKey.current = selectionKey
  const latestRegistration = useRef<RegistrationSubmission | undefined>(undefined)
  const isAssisted = (field: DraftField) => draft.assisted.includes(field)
  const clearAssisted = (field: DraftField) => setDrafts(current => {
    const previous = current[selectionKey] ?? defaultDraft
    return { ...current, [selectionKey]: { ...previous, assisted: previous.assisted.filter(item => item !== field) } }
  })
  const markAssisted = (fields: readonly DraftField[]) => setDrafts(current => {
    const previous = current[selectionKey] ?? defaultDraft
    return { ...current, [selectionKey]: { ...previous, assisted: [...new Set([...previous.assisted, ...fields])] } }
  })

  const catalog = useQuery({
    queryFn: ({ signal }) => getRegistrationCatalog(signal),
    queryKey: ['registration-catalog', ...scope],
  })
  const registrationsRootKey = ['registration-queue', ...scope] as const
  const registrationsKey = [...registrationsRootKey, registrationPage] as const
  const registrations = useQuery({
    enabled: recordPeriod === 'all',
    queryFn: ({ signal }) => getRegistrationQueue(signal, registrationPage),
    queryKey: registrationsKey,
  })
  const virtualDate = catalog.data?.virtualDate
  const todayRegistrations = useInfiniteQuery({
    enabled: recordPeriod === 'today' && virtualDate !== undefined,
    queryKey: [...registrationsRootKey, 'today', virtualDate],
    initialPageParam: 1,
    queryFn: ({ signal, pageParam }) => getRegistrationQueue(signal, pageParam),
    getNextPageParam: last => last.items.length > 0 && last.page * last.pageSize < last.total && virtualDate !== undefined
      && hospitalDate(last.items[last.items.length - 1]!.arrivedAt) >= virtualDate ? last.page + 1 : undefined,
  })
  const recordItems = recordPeriod === 'all' ? registrations.data?.items ?? []
    : (todayRegistrations.data?.pages.flatMap(page => page.items) ?? []).filter(item => hospitalDate(item.arrivedAt) === virtualDate)
  const recordsPending = recordPeriod === 'all' ? registrations.isPending : !catalog.isError && todayRegistrations.isPending
  const recordsError = recordPeriod === 'all' ? registrations.error : catalog.error ?? todayRegistrations.error
  const registrationCount = recordPeriod === 'all' ? registrations.data?.total : todayRegistrations.data?.pages[0]?.total
  const patients = useQuery({
    enabled: submittedQuery !== '',
    queryFn: ({ signal }) => searchPatients(submittedQuery, signal, patientPage),
    queryKey: ['patient-search', ...scope, submittedQuery, patientPage],
  })
  const waitingCasesRootKey = ['registration-synthetic-cases', ...scope] as const
  const waitingCases = useQuery({
    queryFn: ({ signal }) => getSyntheticCasesAwaitingRegistration(
      signal,
      casePage,
      submittedCaseQuery || undefined,
    ),
    queryKey: [...waitingCasesRootKey, submittedCaseQuery, casePage],
  })
  const createPatient = useMutation({
    mutationFn: (submission: PatientSubmission) => createSyntheticPatient(submission.input, newIdempotencyKey()),
    onSuccess: (response, submission) => {
      setDrafts(current => {
        const previous = current[submission.selectionKey] ?? defaultDraft
        const patient = { name: previous.name, identifier: previous.identifier, birthDate: previous.birthDate, gender: previous.gender }
        if (JSON.stringify(patient) !== JSON.stringify(submission.input)) return current
        return { ...current, [submission.selectionKey]: { ...previous, ...defaultDraft, departmentId: previous.departmentId,
          locationId: previous.locationId, visitTypeId: previous.visitTypeId,
          assisted: previous.assisted.filter(field => !['birthDate', 'gender', 'identifier', 'name'].includes(field)) } }
      })
      if (latestSelectionKey.current !== submission.selectionKey
        || JSON.stringify(latestPatientDraft.current) !== JSON.stringify(submission.input)) return
      setSelection({ kind: 'patient', patient: response.data.patient })
      queueView.setTab('search')
    },
  })
  const submitRegistration = useMutation<RegistrationMutationResult, Error, RegistrationSubmission>({
    mutationFn: (submission: RegistrationSubmission) => submission.kind === 'patient'
      ? registerOutpatient(submission.input, newIdempotencyKey())
      : startSyntheticCaseVisit(submission.input, newIdempotencyKey()),
    onError: (_error, submission) => {
      if (submission.kind === 'synthetic-case' && latestSelectionKey.current === submission.selectionKey
        && JSON.stringify(latestRegistration.current?.input) === JSON.stringify(submission.input)) setSelection(undefined)
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: registrationsRootKey }),
        queryClient.invalidateQueries({ queryKey: waitingCasesRootKey }),
      ])
    },
    onSuccess: (_response, submission) => {
      if (latestSelectionKey.current === submission.selectionKey
        && JSON.stringify(latestRegistration.current?.input) === JSON.stringify(submission.input)) setSelection(undefined)
    },
  })

  const resolvedDepartmentId = departmentId || catalog.data?.departments[0]?.id || ''
  const resolvedLocationId = locationId || catalog.data?.locations[0]?.id || ''
  const resolvedVisitTypeId = visitTypeId || catalog.data?.visitTypes[0]?.id || ''
  const registrationSubmission: RegistrationSubmission | undefined = selection === undefined || catalog.data === undefined
    || resolvedDepartmentId === '' || resolvedLocationId === '' || resolvedVisitTypeId === '' ? undefined
    : selection.kind === 'patient' ? { kind: 'patient', selectionKey, input: {
      departmentId: resolvedDepartmentId, locationId: resolvedLocationId, patientId: selection.patient.id,
      patientVersion: selection.patient.versionId, visitDate: catalog.data.virtualDate, visitTypeId: resolvedVisitTypeId,
    } } : { kind: 'synthetic-case', selectionKey, input: {
      activeBriefRevision: selection.syntheticCase.activeBriefRevision, caseId: selection.syntheticCase.caseId,
      departmentId: resolvedDepartmentId, expectedCaseRevision: selection.syntheticCase.caseRevision,
      locationId: resolvedLocationId, visitDate: catalog.data.virtualDate, visitTypeId: resolvedVisitTypeId,
    } }
  latestRegistration.current = registrationSubmission
  const selectedName = selection?.kind === 'patient'
    ? selection.patient.name
    : selection?.syntheticCase.name
  const genderItems = genderValues.map(value => ({
    label: messages[`gender_${value}`],
    value,
  }))
  const departmentItems = catalog.data?.departments.map(item => ({
    label: locale === 'zh-CN' ? item.nameZh : item.nameEn,
    value: item.id,
  })) ?? []
  const visitTypeItems = catalog.data?.visitTypes.map(item => ({
    label: `${locale === 'zh-CN' ? item.nameZh : item.nameEn} · ${item.priceFen === undefined ? text('价格未登记', 'Price unavailable') : formatFen(item.priceFen, locale)}`,
    value: item.id,
  })) ?? []
  const locationItems = catalog.data?.locations.map(item => ({
    label: locale === 'zh-CN' ? item.nameZh : item.nameEn,
    value: item.id,
  })) ?? []
  const caseTypeLabels = {
    'follow-up': messages.followUpCase,
    'new-problem': messages.newProblemCase,
    preventive: messages.preventiveCase,
  } as const

  const agentPage = useMemo(() => ({
    actions: {
      'registration.synthetic-case.search': {
        description: 'Search ready Synthetic Cases visible to the current registrar.',
        parameters: {
          type: 'object' as const,
          properties: { query: { type: 'string', maxLength: 100 } },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async (raw: unknown, signal: AbortSignal) => {
          const query = agentString(raw, 'query', 100)
          queueView.setTab('cases')
          setCaseQuery(query)
          setSubmittedCaseQuery(query)
          setCasePage(1)
          return getSyntheticCasesAwaitingRegistration(signal, 1, query)
        },
      },
      'registration.synthetic-case.select': {
        description: 'Select one Synthetic Case from the current registrar result.',
        enabled: (waitingCases.data?.items.length ?? 0) > 0,
        parameters: {
          type: 'object' as const,
          properties: { caseId: { type: 'string', maxLength: 128 } },
          required: ['caseId'],
          additionalProperties: false,
        },
        execute: (raw: unknown) => {
          const caseId = agentString(raw, 'caseId', 128)
          const selected = waitingCases.data?.items.find(item => item.caseId === caseId)
          if (selected === undefined) {
            throw new Error('Synthetic Case is not in the current registrar result')
          }
          setSelection({ kind: 'synthetic-case', syntheticCase: selected })
          queueView.setTab('cases')
          return { caseId, selected: true }
        },
      },
      'registration.patient.search': {
        description: 'Search synthetic patients visible to the current registrar.',
        parameters: {
          type: 'object' as const,
          properties: { query: { type: 'string', maxLength: 100 } },
          required: ['query'],
          additionalProperties: false,
        },
        execute: async (raw: unknown, signal: AbortSignal) => {
          const query = agentString(raw, 'query', 100)
          queueView.setTab('search')
          setPatientQuery(query)
          setSubmittedQuery(query)
          setPatientPage(1)
          return searchPatients(query, signal, 1)
        },
      },
      'registration.patient.select': {
        description: 'Select one patient from the current registrar search result.',
        enabled: (patients.data?.items.length ?? 0) > 0,
        parameters: {
          type: 'object' as const,
          properties: { patientId: { type: 'string', maxLength: 128 } },
          required: ['patientId'],
          additionalProperties: false,
        },
        execute: (raw: unknown) => {
          const patientId = agentString(raw, 'patientId', 128)
          const patient = patients.data?.items.find(item => item.id === patientId)
          if (patient === undefined) throw new Error('Patient is not in the current search result')
          setSelection({ kind: 'patient', patient })
          queueView.setTab('search')
          return { patientId, selected: true }
        },
      },
      'registration.patient.draft.set': {
        description: 'Fill the temporary patient draft without creating a Patient.',
        parameters: {
          type: 'object' as const,
          properties: {
            birthDate: { type: 'string', format: 'date' },
            gender: { type: 'string', enum: genderValues },
            identifier: { type: 'string', maxLength: 80 },
            name: { type: 'string', maxLength: 80 },
          },
          required: ['birthDate', 'gender', 'identifier', 'name'],
          additionalProperties: false,
        },
        execute: (raw: unknown) => {
          const values = agentRecord(raw)
          const nextGender = values.gender
          if (!genderValues.includes(nextGender as typeof genderValues[number])) {
            throw new TypeError('gender is invalid')
          }
          setBirthDate(agentString(raw, 'birthDate', 10))
          setGender(nextGender as typeof gender)
          setIdentifier(agentString(raw, 'identifier', 80))
          setName(agentString(raw, 'name', 80))
          markAssisted(['birthDate', 'gender', 'identifier', 'name'])
          queueView.setTab('create')
          return { updated: true }
        },
      },
      'registration.draft.set': {
        description: 'Fill department, visit type, and location in the registration draft.',
        enabled: catalog.data !== undefined
          && catalog.data.departments.length > 0
          && catalog.data.locations.length > 0
          && catalog.data.visitTypes.length > 0,
        parameters: {
          type: 'object' as const,
          properties: {
            departmentId: { type: 'string', maxLength: 128 },
            locationId: { type: 'string', maxLength: 128 },
            visitTypeId: { type: 'string', maxLength: 128 },
          },
          required: ['departmentId', 'locationId', 'visitTypeId'],
          additionalProperties: false,
        },
        execute: (raw: unknown) => {
          const nextDepartment = agentString(raw, 'departmentId', 128)
          const nextLocation = agentString(raw, 'locationId', 128)
          const nextVisitType = agentString(raw, 'visitTypeId', 128)
          if (!catalog.data?.departments.some(item => item.id === nextDepartment)) {
            throw new Error('Department is not available in the current registration catalog')
          }
          if (!catalog.data.locations.some(item => item.id === nextLocation)) {
            throw new Error('Location is not available in the current registration catalog')
          }
          if (!catalog.data.visitTypes.some(item => item.id === nextVisitType)) {
            throw new Error('Visit type is not available in the current registration catalog')
          }
          setDepartmentId(nextDepartment)
          setLocationId(nextLocation)
          setVisitTypeId(nextVisitType)
          markAssisted(['departmentId', 'locationId', 'visitTypeId'])
          queueView.setTab(selection?.kind === 'synthetic-case' ? 'cases' : 'search')
          return { updated: true }
        },
      },
      'registration.patient.create.propose': {
        description: 'Open human review for the current temporary patient draft.',
        enabled: name.trim() !== '' && identifier.trim() !== '' && birthDate !== '',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => agentReview.request({
          confirmLabel: locale => getWorkspaceMessages(locale).createTemporaryPatient,
          description: `${name} · ${identifier} · ${birthDate}`,
          onConfirm: () => createPatient.mutateAsync({ input: patientDraft, selectionKey }),
          signal,
          title: locale => getWorkspaceMessages(locale).createTemporaryPatient,
        }),
      },
      'registration.outpatient.propose': {
        description: 'Open human review for outpatient registration of the selected patient.',
        enabled: selection?.kind === 'patient'
          && resolvedDepartmentId !== ''
          && resolvedLocationId !== ''
          && resolvedVisitTypeId !== '',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          if (selection?.kind !== 'patient' || registrationSubmission?.kind !== 'patient') throw new Error(messages.selectPatientFirst)
          return agentReview.request({
            confirmLabel: locale => getWorkspaceMessages(locale).confirmRegistration,
            description: `${selection.patient.name} · ${resolvedDepartmentId} · ${resolvedVisitTypeId}`,
            onConfirm: () => submitRegistration.mutateAsync(registrationSubmission),
            signal,
            title: locale => getWorkspaceMessages(locale).registrationDetails,
          })
        },
      },
      'registration.synthetic-case.start.propose': {
        description: 'Open human review for outpatient registration of the selected Synthetic Case.',
        enabled: selection?.kind === 'synthetic-case'
          && resolvedDepartmentId !== ''
          && resolvedLocationId !== ''
          && resolvedVisitTypeId !== '',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => {
          if (selection?.kind !== 'synthetic-case' || registrationSubmission?.kind !== 'synthetic-case') throw new Error(messages.selectPatientFirst)
          return agentReview.request({
            confirmLabel: locale => getWorkspaceMessages(locale).confirmRegistration,
            description: `${selection.syntheticCase.name} · ${resolvedDepartmentId} · ${resolvedVisitTypeId}`,
            onConfirm: () => submitRegistration.mutateAsync(registrationSubmission),
            signal,
            title: locale => getWorkspaceMessages(locale).registrationDetails,
          })
        },
      },
    },
    claim: {
      version: 1 as const,
      viewId: 'registration' as const,
      viewRevision: agentViewRevision({
        birthDate,
        departmentId: resolvedDepartmentId,
        gender,
        identifier,
        locationId: resolvedLocationId,
        name,
        casePage,
        patientPage,
        registrationPage,
        recordPeriod,
        queueTab,
        todayPages: todayRegistrations.data?.pages.length,
        selectedCaseId: selection?.kind === 'synthetic-case' ? selection.syntheticCase.caseId : undefined,
        selectedPatientId: selection?.kind === 'patient' ? selection.patient.id : undefined,
        submittedCaseQuery,
        submittedQuery,
        visitTypeId: resolvedVisitTypeId,
      }),
      ...(selection?.kind === 'synthetic-case'
        ? {
            selection: {
              id: selection.syntheticCase.caseId,
              kind: 'synthetic-case' as const,
              version: String(selection.syntheticCase.caseRevision),
            },
          }
        : selection?.kind !== 'patient' ? {} : {
            selection: {
              id: selection.patient.id,
              kind: 'patient' as const,
              version: selection.patient.versionId,
            },
          }),
      draft: {
        dirty: name !== '' || identifier !== '',
        id: selection?.kind === 'synthetic-case'
          ? selection.syntheticCase.caseId
          : selection?.kind === 'patient' ? selection.patient.id : 'new-patient',
        kind: selection === undefined ? 'patient' as const : 'registration' as const,
        revision: agentViewRevision({
          birthDate,
          departmentId: resolvedDepartmentId,
          gender,
          identifier,
          locationId: resolvedLocationId,
          name,
          visitTypeId: resolvedVisitTypeId,
        }),
      },
      ui: {
        status: catalog.isError || recordsError !== null || waitingCases.isError
          ? 'error' as const
          : catalog.isPending || recordsPending || waitingCases.isPending
            ? 'loading' as const
            : waitingCases.data?.items.length === 0 && recordItems.length === 0
              ? 'empty' as const
              : 'ready' as const,
        ...(submittedCaseQuery !== ''
          ? { search: submittedCaseQuery }
          : submittedQuery === '' ? {} : { search: submittedQuery }),
      },
    },
    label: 'ClinMesh · 门诊挂号',
    readState: () => ({
      patientDraft: { birthDate, gender, identifier, name },
      registrationDraft: {
        departmentId: resolvedDepartmentId,
        locationId: resolvedLocationId,
        visitTypeId: resolvedVisitTypeId,
      },
      registrationCount: registrationCount ?? 0,
      syntheticCases: waitingCases.data?.items ?? [],
      selectedSyntheticCase: selection?.kind === 'synthetic-case'
        ? selection.syntheticCase
        : null,
      selectedPatient: selection?.kind === 'patient' ? {
        id: selection.patient.id,
        name: selection.patient.name,
        versionId: selection.patient.versionId,
      } : null,
    }),
  }), [
    agentReview,
    birthDate,
    casePage,
    catalog.data,
    catalog.isError,
    catalog.isPending,
    createPatient.mutateAsync,
    departmentId,
    gender,
    identifier,
    locationId,
    messages,
    name,
    patientPage,
    patients.data,
    submitRegistration.mutateAsync,
    registrationPage,
    recordPeriod,
    queueTab,
    queueView.setTab,
    recordsPending,
    recordsError,
    recordItems.length,
    registrationCount,
    todayRegistrations.data?.pages.length,
    registrations.data,
    registrations.isError,
    registrations.isPending,
    resolvedDepartmentId,
    resolvedLocationId,
    resolvedVisitTypeId,
    selection,
    selectionKey,
    submittedCaseQuery,
    submittedQuery,
    visitTypeId,
    waitingCases.data,
    waitingCases.isError,
    waitingCases.isPending,
  ])
  useRegisterAgentPage(agentPage)

  const creatingPatient = queueTab === 'create'
  const registrationComplete = !creatingPatient && selection === undefined && submitRegistration.isSuccess
  const missing = creatingPatient
    ? [name.trim() === '' ? messages.name : '', identifier.trim() === '' ? messages.temporaryIdentifier : '', birthDate === '' ? messages.birthDate : ''].filter(Boolean)
    : [selection === undefined ? messages.patient : '', resolvedDepartmentId === '' ? messages.department : '',
      resolvedVisitTypeId === '' ? messages.visitType : '', resolvedLocationId === '' ? messages.location : ''].filter(Boolean)
  const disabledReason = creatingPatient && layoutView.queueCollapsed ? text('展开队列后核对建档资料', 'Expand the queue to review the patient details')
    : !creatingPatient && catalog.isError ? text('挂号目录读取失败，请重试', 'Retry the failed registration catalog')
    : missing.length ? text('还差：', 'Complete: ') + missing.join(locale === 'zh-CN' ? '、' : ', ')
      : submitRegistration.isPending ? text('正在办理挂号', 'Registering patient') : ''
  const selectedBirthDate = selection?.kind === 'patient' ? selection.patient.birthDate : selection?.syntheticCase.birthDate
  const selectedGender = selection?.kind === 'patient' ? selection.patient.gender : selection?.syntheticCase.gender

  const queuePanel = <section aria-labelledby="patient-heading" className="min-w-0">
    <WorkspaceQueueCard title={<h2 id="patient-heading">{messages.patientSelection}</h2>}>
      <WorkspaceModeSwitch />
      <Tabs value={queueTab} onValueChange={value => { if (typeof value === 'string') queueView.setTab(value) }}>
        <TabsList className="h-auto w-full">
          <TabsTrigger value="cases">{text('待挂号', 'Awaiting registration')}</TabsTrigger>
          <TabsTrigger value="search">{text('检索', 'Search')}</TabsTrigger>
          <TabsTrigger value="create">{text('建档', 'Create record')}</TabsTrigger>
        </TabsList>
        <TabsContent value="cases" className="pt-3">
          <form className="flex items-end gap-2" onSubmit={event => {
            event.preventDefault(); setCasePage(1); setSubmittedCaseQuery(caseQuery.trim())
          }}>
            <Field><FieldLabel className="sr-only" htmlFor="registration-case-query">{messages.caseSearchTerm}</FieldLabel>
              <Input id="registration-case-query" value={caseQuery} onInput={event => setCaseQuery(event.currentTarget.value)} placeholder={messages.caseSearchPlaceholder} />
            </Field>
            <Button size="icon" type="submit" aria-label={messages.search}><SearchIcon aria-hidden="true" /></Button>
          </form>
          {waitingCases.isPending ? <Skeleton role="status" aria-label={messages.caseSearchLoading} className="mt-3 h-28 w-full" />
            : waitingCases.isError ? <Alert variant="destructive" className="mt-3"><CircleAlertIcon aria-hidden="true" />
              <AlertTitle>{getWorkspaceErrorTitle(waitingCases.error, messages, messages.waitingCasesUnavailable)}</AlertTitle>
              <AlertDescription>{getWorkspaceErrorMessage(waitingCases.error, messages)}</AlertDescription>
              <Button type="button" size="sm" variant="outline" onClick={() => void waitingCases.refetch()}>{text('重试读取待挂号病例', 'Retry awaiting cases')}</Button>
            </Alert> : waitingCases.data.items.length === 0 ? <Empty className="mt-3 min-h-24"><EmptyHeader>
              <EmptyMedia variant="icon"><ClipboardListIcon aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>{messages.noWaitingCases}</EmptyTitle><EmptyDescription>{messages.noWaitingCasesDescription}</EmptyDescription>
            </EmptyHeader></Empty> : <div className="mt-3 flex flex-col gap-2">
              <div data-workspace-queue-items="">{waitingCases.data.items.map(item => {
                const selected = selection?.kind === 'synthetic-case' && selection.syntheticCase.caseId === item.caseId
                return <Button key={item.caseId} data-agent-selection={item.caseId} type="button"
                  aria-label={(selected ? messages.selectedCaseAction : messages.selectCase) + ' ' + item.name} aria-pressed={selected}
                  className="h-auto w-full justify-start whitespace-normal py-2 text-left" variant={selected ? 'secondary' : 'outline'}
                  onClick={() => setSelection(selected ? undefined : { kind: 'synthetic-case', syntheticCase: item })}>
                  <span className="flex min-w-0 flex-1 flex-col gap-1"><strong>{item.name}</strong>
                    <span className="text-xs text-muted-foreground">{item.mrn} · {messages[`gender_${item.gender}`]}</span>
                    <span className="text-xs text-muted-foreground">{caseTypeLabels[item.caseType]} · {item.birthDate}</span>
                  </span>{selected ? <CheckIcon aria-hidden="true" /> : null}
                </Button>
              })}</div>
              <PaginationControls messages={messages} onPageChange={setCasePage} {...waitingCases.data} />
            </div>}
        </TabsContent>
        <TabsContent value="search" className="pt-3">
          <form className="flex items-end gap-2" onSubmit={event => {
            event.preventDefault(); setPatientPage(1); setSubmittedQuery(patientQuery.trim())
          }}>
            <Field><FieldLabel className="sr-only" htmlFor="patient-query">{messages.patientSearchTerm}</FieldLabel>
              <Input id="patient-query" required value={patientQuery} onInput={event => setPatientQuery(event.currentTarget.value)} placeholder={messages.patientSearchPlaceholder} />
            </Field><Button size="icon" type="submit" aria-label={messages.search}><SearchIcon aria-hidden="true" /></Button>
          </form>
          {patients.isPending && submittedQuery !== '' ? <Skeleton role="status" aria-label={messages.patientSearchLoading} className="mt-3 h-24 w-full" />
            : patients.isError ? <Alert variant="destructive" className="mt-3">
              <AlertTitle>{getWorkspaceErrorTitle(patients.error, messages, messages.patientSearchUnavailable)}</AlertTitle>
              <AlertDescription>{getWorkspaceErrorMessage(patients.error, messages)}</AlertDescription>
              <Button type="button" size="sm" variant="outline" onClick={() => void patients.refetch()}>{text('重试检索患者', 'Retry patient search')}</Button>
            </Alert> : patients.data === undefined || patients.data.items.length === 0 ? <Empty className="mt-3 min-h-24"><EmptyHeader>
              <EmptyTitle>{patients.data === undefined ? text('输入检索词查找患者', 'Search for a patient') : messages.noPatients}</EmptyTitle>
              <EmptyDescription>{text('可以修改检索词，或在建档页登记新患者。', 'Change the search or create a new patient record.')}</EmptyDescription>
            </EmptyHeader></Empty> : <div className="mt-3 flex flex-col gap-2">
              <div data-workspace-queue-items="">{patients.data.items.map(patient => {
                const selected = selection?.kind === 'patient' && selection.patient.id === patient.id
                return <Button key={patient.id} data-agent-selection={patient.id} type="button"
                  aria-label={(selected ? messages.selectedPatientAction : messages.selectPatient) + ' ' + patient.name} aria-pressed={selected}
                  className="h-auto w-full justify-start whitespace-normal py-2 text-left" variant={selected ? 'secondary' : 'outline'}
                  onClick={() => setSelection(selected ? undefined : { kind: 'patient', patient })}>
                  <span className="flex min-w-0 flex-1 flex-col gap-1"><strong>{patient.name}</strong><span className="break-all text-xs text-muted-foreground">{patient.identifier}</span></span>
                  {selected ? <CheckIcon aria-hidden="true" /> : null}
                </Button>
              })}</div>
              <PaginationControls messages={messages} onPageChange={setPatientPage} {...patients.data} />
            </div>}
        </TabsContent>
        <TabsContent value="create" className="pt-3">
          <form id="registration-patient-create" onSubmit={event => {
            event.preventDefault(); createPatient.mutate({ input: patientDraft, selectionKey })
          }}><FieldGroup>
            <AgentDraftField assisted={isAssisted('name')} locale={locale} onUserEdit={() => clearAssisted('name')}>
              <Field><FieldLabel htmlFor="patient-name">{messages.name}</FieldLabel><Input id="patient-name" required value={name} onInput={event => setName(event.currentTarget.value)} /></Field>
            </AgentDraftField>
            <AgentDraftField assisted={isAssisted('identifier')} locale={locale} onUserEdit={() => clearAssisted('identifier')}>
              <Field><FieldLabel htmlFor="patient-identifier">{messages.temporaryIdentifier}</FieldLabel><Input id="patient-identifier" required value={identifier} onInput={event => setIdentifier(event.currentTarget.value)} /></Field>
            </AgentDraftField>
            <AgentDraftField assisted={isAssisted('birthDate')} locale={locale} onUserEdit={() => clearAssisted('birthDate')}>
              <Field><FieldLabel htmlFor="patient-birth-date">{messages.birthDate}</FieldLabel><Input id="patient-birth-date" type="date" required value={birthDate} onInput={event => setBirthDate(event.currentTarget.value)} /></Field>
            </AgentDraftField>
            <AgentDraftField assisted={isAssisted('gender')} locale={locale} onUserEdit={() => clearAssisted('gender')}>
              <Field><FieldLabel htmlFor="patient-gender">{messages.gender}</FieldLabel><WorkspaceSelect id="patient-gender" value={gender} items={genderItems}
                onValueChange={value => { if (value !== null) { clearAssisted('gender'); setGender(value as typeof gender) } }} /></Field>
            </AgentDraftField>
            {createPatient.isError ? <Alert variant="destructive"><AlertTitle>{getWorkspaceErrorTitle(createPatient.error, messages, messages.operationFailed)}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(createPatient.error, messages)}</AlertDescription></Alert> : null}
          </FieldGroup></form>
        </TabsContent>
      </Tabs>
    </WorkspaceQueueCard>
  </section>

  const registrationPanel = <section aria-labelledby="registration-form-heading" className="min-w-0">
    <WorkspaceCard title={<h2 id="registration-form-heading">{messages.registrationDetails}</h2>}>
      {catalog.isPending ? <Skeleton className="h-36 w-full" /> : catalog.isError ? <Alert variant="destructive">
        <AlertTitle>{getWorkspaceErrorTitle(catalog.error, messages, messages.registrationUnavailable)}</AlertTitle>
        <AlertDescription>{getWorkspaceErrorMessage(catalog.error, messages)}</AlertDescription>
        <Button type="button" variant="outline" onClick={() => void catalog.refetch()}>{text('重试读取挂号目录', 'Retry registration catalog')}</Button>
      </Alert> : selection === undefined ? <Empty><EmptyHeader><EmptyTitle>{messages.selectPatientFirst}</EmptyTitle>
        <EmptyDescription>{text('从左侧待挂号或检索中选择患者；新患者请先建档。', 'Choose a patient from the queue or search. Create a record for a new patient.')}</EmptyDescription>
      </EmptyHeader></Empty> : <FieldGroup>
        <AgentDraftField assisted={isAssisted('departmentId')} locale={locale} onUserEdit={() => clearAssisted('departmentId')}>
          <Field><FieldLabel htmlFor="registration-department">{messages.department}</FieldLabel><WorkspaceSelect id="registration-department" items={departmentItems} value={resolvedDepartmentId}
            onValueChange={value => { clearAssisted('departmentId'); setDepartmentId(value ?? '') }} /></Field>
        </AgentDraftField>
        <AgentDraftField assisted={isAssisted('visitTypeId')} locale={locale} onUserEdit={() => clearAssisted('visitTypeId')}>
          <Field><FieldLabel htmlFor="registration-visit-type">{messages.visitType}</FieldLabel><WorkspaceSelect id="registration-visit-type" items={visitTypeItems} value={resolvedVisitTypeId}
            onValueChange={value => { clearAssisted('visitTypeId'); setVisitTypeId(value ?? '') }} /></Field>
        </AgentDraftField>
        <AgentDraftField assisted={isAssisted('locationId')} locale={locale} onUserEdit={() => clearAssisted('locationId')}>
          <Field><FieldLabel htmlFor="registration-location">{messages.location}</FieldLabel><WorkspaceSelect id="registration-location" items={locationItems} value={resolvedLocationId}
            onValueChange={value => { clearAssisted('locationId'); setLocationId(value ?? '') }} /></Field>
        </AgentDraftField>
        <Field><FieldLabel htmlFor="registration-visit-date">{messages.visitDate}</FieldLabel><Input id="registration-visit-date" readOnly value={catalog.data.virtualDate} /></Field>
        {submitRegistration.isError ? <Alert variant="destructive"><AlertTitle>{getWorkspaceErrorTitle(submitRegistration.error, messages, messages.operationFailed)}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(submitRegistration.error, messages)}</AlertDescription></Alert> : null}
      </FieldGroup>}
    </WorkspaceCard>
  </section>

  const recordsPanel = <section aria-labelledby="registration-records-heading" className="min-w-0">
    <WorkspaceCard title={<h2 id="registration-records-heading">{messages.registrationRecords}</h2>}>
      <ToggleGroup aria-label={text('挂号记录范围', 'Registration record period')} value={[recordPeriod]} size="sm" spacing={0} variant="outline"
        onValueChange={values => { const period = values[0]; if (period === 'today' || period === 'all') recordView.setTab(period) }}>
        <ToggleGroupItem value="today">{text('今日', 'Today')}</ToggleGroupItem><ToggleGroupItem value="all">{text('全部', 'All')}</ToggleGroupItem>
      </ToggleGroup>
      <p className="text-xs text-muted-foreground">{recordPeriod === 'today'
        ? text('已加载 ' + recordItems.length + ' 条今日记录', 'Loaded ' + recordItems.length + ' registrations for today')
        : registrations.data ? text('全部 ' + registrations.data.total + ' 条记录', 'All ' + registrations.data.total + ' registrations') : text('全部挂号记录', 'All registration records')}</p>
      {recordsPending ? <Skeleton className="h-24 w-full" /> : recordsError !== null ? <Alert variant="destructive">
        <AlertTitle>{getWorkspaceErrorTitle(recordsError, messages, messages.registrationUnavailable)}</AlertTitle>
        <AlertDescription>{getWorkspaceErrorMessage(recordsError, messages)}</AlertDescription>
        <Button type="button" size="sm" variant="outline" onClick={() => {
          if (recordPeriod === 'today' && catalog.isError) void catalog.refetch()
          else if (recordPeriod === 'all') void registrations.refetch()
          else void todayRegistrations.refetch()
        }}>{text('重试读取挂号记录', 'Retry registration records')}</Button>
      </Alert> : recordItems.length === 0 ? <Empty className="min-h-24"><EmptyHeader><EmptyTitle>{messages.noRegistrations}</EmptyTitle>
        <EmptyDescription>{recordPeriod === 'today' ? text('今日暂无挂号记录；可以先办理挂号，或切换全部查看历史。', 'No registrations today. Register a patient or switch to All for history.') : messages.noRegistrationsDescription}</EmptyDescription>
      </EmptyHeader></Empty> : <Table>
        <TableHeader className="sr-only"><TableRow><TableHead>{messages.registrationRecords}</TableHead></TableRow></TableHeader>
        <TableBody>{recordItems.map(item => <TableRow key={item.registrationId}><TableCell className="whitespace-normal">
          <div className="flex min-w-0 flex-col gap-2"><strong>{item.patient.name}</strong><RegistrationNumber messages={messages} registrationNumber={item.registrationNumber} />
            <time className="tabular-nums text-xs text-muted-foreground" dateTime={item.arrivedAt}>{new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(item.arrivedAt))}</time>
            <Badge className="w-fit" variant="outline">{item.status === 'awaiting-triage' ? messages.awaitingTriage : item.status}</Badge>
          </div>
        </TableCell></TableRow>)}</TableBody>
      </Table>}
      {recordPeriod === 'all' && registrations.data !== undefined ? <PaginationControls ariaLabel={messages.registrationRecords} messages={messages} onPageChange={setRegistrationPage} {...registrations.data} />
        : todayRegistrations.hasNextPage ? <Button type="button" variant="outline" disabled={todayRegistrations.isFetchingNextPage} onClick={() => void todayRegistrations.fetchNextPage()}>{text('加载更多今日记录', 'Load more registrations for today')}</Button> : null}
    </WorkspaceCard>
  </section>

  return <WorkspaceCardLayout id="registration-workspace" locale={locale} flow={outpatientFlow(locale)} activeStep="registration" queue={queuePanel}
    patient={selection === undefined ? undefined : <section aria-label={text('当前患者', 'Current patient')}>
      <WorkspacePatientCard title={selectedName} actions={<Button aria-label={messages.clearSelection} variant="ghost" size="icon-xs" onClick={() => setSelection(undefined)}><XIcon aria-hidden="true" /></Button>}>
        <dl className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <div><dt className="text-xs text-muted-foreground">{messages.birthDate}</dt><dd>{selectedBirthDate ?? text('未记录', 'Not recorded')}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{messages.gender}</dt><dd>{selectedGender === undefined ? text('未记录', 'Not recorded') : messages[`gender_${selectedGender}`]}</dd></div>
        </dl>
      </WorkspacePatientCard>
    </section>} aside={recordsPanel}
    action={<WorkspaceActionBar summary={selectedName} reason={registrationComplete ? text('已完成挂号，等待分诊护士接诊', 'Registration complete; awaiting triage') : disabledReason}
      tone={registrationComplete ? 'complete' : disabledReason ? 'blocked' : 'normal'}
      action={registrationComplete ? undefined : creatingPatient
        ? <Button type="submit" form="registration-patient-create" disabled={createPatient.isPending || missing.length > 0 || layoutView.queueCollapsed}><UserPlusIcon aria-hidden="true" data-icon="inline-start" />{messages.createTemporaryPatient}</Button>
        : <Button type="button" disabled={registrationSubmission === undefined || submitRegistration.isPending} onClick={() => { if (registrationSubmission) submitRegistration.mutate(registrationSubmission) }}><ClipboardPlusIcon aria-hidden="true" data-icon="inline-start" />{messages.confirmRegistration}</Button>} />}>
    {registrationPanel}
  </WorkspaceCardLayout>
}


function agentRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Agent action input must be an object')
  }
  return value as Record<string, unknown>
}

function agentString(value: unknown, key: string, maximum: number): string {
  const candidate = agentRecord(value)[key]
  if (typeof candidate !== 'string' || candidate.trim() === '' || candidate.length > maximum) {
    throw new TypeError(`${key} is invalid`)
  }
  return candidate.trim()
}
