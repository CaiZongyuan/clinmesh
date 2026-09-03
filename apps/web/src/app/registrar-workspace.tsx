import type { PatientSummary, SessionContext } from '@clinmesh/contracts/his'
import type { SyntheticCaseRegistrationSummary } from '@clinmesh/contracts/scenario'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@clinmesh/ui/components/empty'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckIcon, CircleAlertIcon, ClipboardListIcon, ClipboardPlusIcon, SearchIcon, UserPlusIcon } from 'lucide-react'
import { useMemo, useState } from 'react'
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
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { agentViewRevision, useRegisterAgentPage } from './agent-page-context.tsx'
import { useAgentReview } from './agent-review.tsx'

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

export function RegistrarWorkspace({ locale, session }: RegistrarWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
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
  const [name, setName] = useState('')
  const [identifier, setIdentifier] = useState('')
  const [birthDate, setBirthDate] = useState('1990-01-01')
  const [gender, setGender] = useState<'female' | 'male' | 'other' | 'unknown'>('male')
  const [departmentId, setDepartmentId] = useState('')
  const [locationId, setLocationId] = useState('')
  const [visitTypeId, setVisitTypeId] = useState('')

  const catalog = useQuery({
    queryFn: ({ signal }) => getRegistrationCatalog(signal),
    queryKey: ['registration-catalog', ...scope],
  })
  const registrationsRootKey = ['registration-queue', ...scope] as const
  const registrationsKey = [...registrationsRootKey, registrationPage] as const
  const registrations = useQuery({
    queryFn: ({ signal }) => getRegistrationQueue(signal, registrationPage),
    queryKey: registrationsKey,
  })
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
    mutationFn: () => createSyntheticPatient({ birthDate, gender, identifier, name }, newIdempotencyKey()),
    onSuccess: response => {
      setSelection({ kind: 'patient', patient: response.data.patient })
      setName('')
      setIdentifier('')
    },
  })
  const submitRegistration = useMutation<RegistrationMutationResult>({
    mutationFn: () => {
      if (selection === undefined || catalog.data === undefined) {
        throw new Error(messages.registrationUnavailable)
      }
      const resolvedDepartmentId = departmentId || catalog.data.departments[0]?.id
      const resolvedLocationId = locationId || catalog.data.locations[0]?.id
      const resolvedVisitTypeId = visitTypeId || catalog.data.visitTypes[0]?.id
      if (
        resolvedDepartmentId === undefined
        || resolvedLocationId === undefined
        || resolvedVisitTypeId === undefined
      ) {
        throw new Error(messages.registrationUnavailable)
      }
      return selection.kind === 'patient'
        ? registerOutpatient({
            departmentId: resolvedDepartmentId,
            locationId: resolvedLocationId,
            patientId: selection.patient.id,
            patientVersion: selection.patient.versionId,
            visitDate: catalog.data.virtualDate,
            visitTypeId: resolvedVisitTypeId,
          }, newIdempotencyKey())
        : startSyntheticCaseVisit({
            activeBriefRevision: selection.syntheticCase.activeBriefRevision,
            caseId: selection.syntheticCase.caseId,
            departmentId: resolvedDepartmentId,
            expectedCaseRevision: selection.syntheticCase.caseRevision,
            locationId: resolvedLocationId,
            visitDate: catalog.data.virtualDate,
            visitTypeId: resolvedVisitTypeId,
          }, newIdempotencyKey())
    },
    onError: () => {
      if (selection?.kind === 'synthetic-case') setSelection(undefined)
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: registrationsRootKey }),
        queryClient.invalidateQueries({ queryKey: waitingCasesRootKey }),
      ])
    },
    onSuccess: () => {
      setSelection(undefined)
    },
  })

  const resolvedDepartmentId = departmentId || catalog.data?.departments[0]?.id || ''
  const resolvedLocationId = locationId || catalog.data?.locations[0]?.id || ''
  const resolvedVisitTypeId = visitTypeId || catalog.data?.visitTypes[0]?.id || ''
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
    label: `${locale === 'zh-CN' ? item.nameZh : item.nameEn} · ${formatFen(item.priceFen ?? 0, locale)}`,
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
          return { updated: true }
        },
      },
      'registration.patient.create.propose': {
        description: 'Open human review for the current temporary patient draft.',
        enabled: name.trim() !== '' && identifier.trim() !== '' && birthDate !== '',
        parameters: { type: 'object' as const, properties: {}, additionalProperties: false },
        execute: (_raw: unknown, signal: AbortSignal) => agentReview.request({
          confirmLabel: messages.createTemporaryPatient,
          description: `${name} · ${identifier} · ${birthDate}`,
          onConfirm: () => createPatient.mutateAsync(),
          signal,
          title: messages.createTemporaryPatient,
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
          if (selection?.kind !== 'patient') throw new Error(messages.selectPatientFirst)
          return agentReview.request({
            confirmLabel: messages.confirmRegistration,
            description: `${selection.patient.name} · ${resolvedDepartmentId} · ${resolvedVisitTypeId}`,
            onConfirm: () => submitRegistration.mutateAsync(),
            signal,
            title: messages.registrationDetails,
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
          if (selection?.kind !== 'synthetic-case') throw new Error(messages.selectPatientFirst)
          return agentReview.request({
            confirmLabel: messages.confirmRegistration,
            description: `${selection.syntheticCase.name} · ${resolvedDepartmentId} · ${resolvedVisitTypeId}`,
            onConfirm: () => submitRegistration.mutateAsync(),
            signal,
            title: messages.registrationDetails,
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
        status: catalog.isPending || registrations.isPending || waitingCases.isPending
          ? 'loading' as const
          : catalog.isError || registrations.isError || waitingCases.isError
            ? 'error' as const
            : waitingCases.data?.items.length === 0 && registrations.data?.items.length === 0
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
      registrationCount: registrations.data?.total ?? 0,
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
    registrations.data,
    registrations.isError,
    registrations.isPending,
    resolvedDepartmentId,
    resolvedLocationId,
    resolvedVisitTypeId,
    selection,
    submittedCaseQuery,
    submittedQuery,
    visitTypeId,
    waitingCases.data,
    waitingCases.isError,
    waitingCases.isPending,
  ])
  useRegisterAgentPage(agentPage)

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(18rem,0.9fr)_minmax(24rem,1.25fr)]">
        <section aria-labelledby="patient-heading" className="flex min-w-0 flex-col gap-4 border-b pb-6 xl:border-r xl:border-b-0 xl:pr-6">
          <h2 className="text-base font-semibold" id="patient-heading">{messages.patientSelection}</h2>
          <Tabs defaultValue="cases">
            <TabsList className="h-auto flex-wrap">
              <TabsTrigger value="cases"><ClipboardListIcon data-icon="inline-start" />{messages.waitingCases}</TabsTrigger>
              <TabsTrigger value="search"><SearchIcon data-icon="inline-start" />{messages.searchPatient}</TabsTrigger>
              <TabsTrigger value="create"><UserPlusIcon data-icon="inline-start" />{messages.temporaryPatientTab}</TabsTrigger>
            </TabsList>
            <TabsContent className="pt-3" value="cases">
              <form
                className="flex items-end gap-2"
                onSubmit={event => {
                  event.preventDefault()
                  setCasePage(1)
                  setSubmittedCaseQuery(caseQuery.trim())
                }}
              >
                <Field>
                  <FieldLabel htmlFor="registration-case-query">{messages.caseSearchTerm}</FieldLabel>
                  <Input
                    id="registration-case-query"
                    onChange={event => setCaseQuery(event.currentTarget.value)}
                    placeholder={messages.caseSearchPlaceholder}
                    value={caseQuery}
                  />
                </Field>
                <Button type="submit"><SearchIcon data-icon="inline-start" />{messages.search}</Button>
              </form>
              {waitingCases.isPending ? (
                <Skeleton
                  aria-label={messages.caseSearchLoading}
                  className="mt-3 h-28 w-full"
                  role="status"
                />
              ) : waitingCases.isError ? (
                <Alert className="mt-3" variant="destructive">
                  <CircleAlertIcon aria-hidden="true" />
                  <AlertTitle>{getWorkspaceErrorTitle(waitingCases.error, messages, messages.waitingCasesUnavailable)}</AlertTitle>
                  <AlertDescription>{getWorkspaceErrorMessage(waitingCases.error, messages)}</AlertDescription>
                </Alert>
              ) : waitingCases.data.items.length === 0 ? (
                <Empty className="mt-3 min-h-32 border">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><ClipboardListIcon aria-hidden="true" /></EmptyMedia>
                    <EmptyTitle>{messages.noWaitingCases}</EmptyTitle>
                    <EmptyDescription>{messages.noWaitingCasesDescription}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="mt-3 flex flex-col gap-2">
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow><TableHead>{messages.patient}</TableHead><TableHead>{messages.mrn}</TableHead><TableHead>{messages.caseType}</TableHead><TableHead>{messages.birthDate}</TableHead><TableHead><span className="sr-only">{messages.selectCase}</span></TableHead></TableRow></TableHeader>
                      <TableBody>
                        {waitingCases.data.items.map(item => {
                          const selected = selection?.kind === 'synthetic-case'
                            && selection.syntheticCase.caseId === item.caseId
                          return (
                          <TableRow data-state={selected ? 'selected' : undefined} key={item.caseId}>
                            <TableCell><div className="font-medium">{item.name}</div><div className="text-xs text-muted-foreground">{messages[`gender_${item.gender}`]}</div></TableCell>
                            <TableCell>{item.mrn}</TableCell>
                            <TableCell>{caseTypeLabels[item.caseType]}</TableCell>
                            <TableCell>{item.birthDate}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                aria-label={`${selected ? messages.selectedCaseAction : messages.selectCase} ${item.name}`}
                                aria-pressed={selected}
                                className="min-w-20"
                                onClick={() => setSelection({
                                  kind: 'synthetic-case',
                                  syntheticCase: item,
                                })}
                                size="sm"
                                type="button"
                                variant={selected ? 'secondary' : 'outline'}
                              >{selected ? <CheckIcon data-icon="inline-start" /> : null}{selected ? messages.selectedAction : messages.selectAction}</Button>
                            </TableCell>
                          </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                  </div>
                  <PaginationControls
                    messages={messages}
                    onPageChange={setCasePage}
                    page={waitingCases.data.page}
                    pageSize={waitingCases.data.pageSize}
                    total={waitingCases.data.total}
                  />
                </div>
              )}
            </TabsContent>
            <TabsContent className="pt-3" value="search">
              <form
                className="flex items-end gap-2"
                onSubmit={event => {
                  event.preventDefault()
                  setPatientPage(1)
                  setSubmittedQuery(patientQuery.trim())
                }}
              >
                <Field>
                  <FieldLabel htmlFor="patient-query">{messages.patientSearchTerm}</FieldLabel>
                  <Input
                    id="patient-query"
                    onChange={event => setPatientQuery(event.currentTarget.value)}
                    placeholder={messages.patientSearchPlaceholder}
                    required
                    value={patientQuery}
                  />
                </Field>
                <Button type="submit"><SearchIcon data-icon="inline-start" />{messages.search}</Button>
              </form>
              {patients.isPending && submittedQuery !== '' ? (
                <Skeleton
                  aria-label={messages.patientSearchLoading}
                  className="mt-3 h-20 w-full"
                  role="status"
                />
              ) : patients.isError ? (
                <Alert className="mt-3" variant="destructive">
                  <CircleAlertIcon aria-hidden="true" />
                  <AlertTitle>{getWorkspaceErrorTitle(patients.error, messages, messages.patientSearchUnavailable)}</AlertTitle>
                  <AlertDescription>{getWorkspaceErrorMessage(patients.error, messages)}</AlertDescription>
                </Alert>
              ) : patients.data !== undefined ? (
                patients.data.items.length === 0 ? (
                  <Empty className="mt-3 min-h-32 border">
                    <EmptyHeader>
                      <EmptyMedia variant="icon"><SearchIcon aria-hidden="true" /></EmptyMedia>
                      <EmptyTitle>{messages.noPatients}</EmptyTitle>
                    </EmptyHeader>
                  </Empty>
                ) : (
                  <div className="mt-3 flex flex-col gap-2">
                    <Table>
                      <TableHeader><TableRow><TableHead>{messages.patient}</TableHead><TableHead>{messages.identifier}</TableHead><TableHead><span className="sr-only">{messages.selectPatient}</span></TableHead></TableRow></TableHeader>
                      <TableBody>
                        {patients.data.items.map(patient => {
                          const selected = selection?.kind === 'patient'
                            && selection.patient.id === patient.id
                          return (
                          <TableRow data-state={selected ? 'selected' : undefined} key={patient.id}>
                            <TableCell>{patient.name}</TableCell>
                            <TableCell>{patient.identifier}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                aria-label={`${selected ? messages.selectedPatientAction : messages.selectPatient} ${patient.name}`}
                                aria-pressed={selected}
                                className="min-w-20"
                                onClick={() => setSelection({ kind: 'patient', patient })}
                                size="sm"
                                type="button"
                                variant={selected ? 'secondary' : 'outline'}
                              >{selected ? <CheckIcon data-icon="inline-start" /> : null}{selected ? messages.selectedAction : messages.selectAction}</Button>
                            </TableCell>
                          </TableRow>
                          )
                        })}
                      </TableBody>
                    </Table>
                    <PaginationControls
                      messages={messages}
                      onPageChange={setPatientPage}
                      page={patients.data.page}
                      pageSize={patients.data.pageSize}
                      total={patients.data.total}
                    />
                  </div>
                )
              ) : null}
            </TabsContent>
            <TabsContent className="pt-3" value="create">
              <form
                onSubmit={event => {
                  event.preventDefault()
                  createPatient.mutate()
                }}
              >
                <FieldGroup>
                  <Field><FieldLabel htmlFor="patient-name">{messages.name}</FieldLabel><Input id="patient-name" onChange={event => setName(event.currentTarget.value)} required value={name} /></Field>
                  <Field><FieldLabel htmlFor="patient-identifier">{messages.temporaryIdentifier}</FieldLabel><Input id="patient-identifier" onChange={event => setIdentifier(event.currentTarget.value)} required value={identifier} /></Field>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field><FieldLabel htmlFor="patient-birth-date">{messages.birthDate}</FieldLabel><Input id="patient-birth-date" onChange={event => setBirthDate(event.currentTarget.value)} required type="date" value={birthDate} /></Field>
                    <Field>
                      <FieldLabel htmlFor="patient-gender">{messages.gender}</FieldLabel>
                      <WorkspaceSelect id="patient-gender" items={genderItems} onValueChange={value => setGender(value as typeof gender)} value={gender} />
                    </Field>
                  </div>
                  <Button disabled={createPatient.isPending} type="submit"><UserPlusIcon data-icon="inline-start" />{messages.createTemporaryPatient}</Button>
                  {createPatient.isError ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{getWorkspaceErrorTitle(createPatient.error, messages, messages.operationFailed)}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(createPatient.error, messages)}</AlertDescription></Alert> : null}
                </FieldGroup>
              </form>
            </TabsContent>
          </Tabs>
        </section>

        <section aria-labelledby="registration-form-heading" className="flex min-w-0 flex-col gap-4">
          <h2 className="text-base font-semibold" id="registration-form-heading">{messages.registrationDetails}</h2>
          {catalog.isPending ? <Skeleton className="h-36 w-full" /> : catalog.isError ? (
            <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{getWorkspaceErrorTitle(catalog.error, messages, messages.registrationUnavailable)}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(catalog.error, messages)}</AlertDescription></Alert>
          ) : (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="registration-department">{messages.department}</FieldLabel>
                <WorkspaceSelect id="registration-department" items={departmentItems} onValueChange={value => setDepartmentId(value ?? '')} value={resolvedDepartmentId} />
              </Field>
              <Field>
                <FieldLabel htmlFor="registration-visit-type">{messages.visitType}</FieldLabel>
                <WorkspaceSelect id="registration-visit-type" items={visitTypeItems} onValueChange={value => setVisitTypeId(value ?? '')} value={resolvedVisitTypeId} />
              </Field>
              <Field>
                <FieldLabel htmlFor="registration-location">{messages.location}</FieldLabel>
                <WorkspaceSelect id="registration-location" items={locationItems} onValueChange={value => setLocationId(value ?? '')} value={resolvedLocationId} />
              </Field>
              <Field><FieldLabel>{messages.visitDate}</FieldLabel><Input disabled value={catalog.data.virtualDate} /></Field>
              <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 border-t bg-background py-3">
                <strong className="min-w-0 text-sm font-medium">{selectedName === undefined ? messages.selectPatientFirst : `${messages.selectedPrefix}${selectedName}`}</strong>
                <Button disabled={selectedName === undefined || submitRegistration.isPending} onClick={() => submitRegistration.mutate()} type="button"><ClipboardPlusIcon data-icon="inline-start" />{messages.confirmRegistration}</Button>
              </div>
              {submitRegistration.isSuccess ? <Alert><CheckIcon aria-hidden="true" /><AlertTitle>{messages.registrationCompleted}</AlertTitle><AlertDescription>{messages.awaitingTriage}</AlertDescription></Alert> : null}
              {submitRegistration.isError ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{getWorkspaceErrorTitle(submitRegistration.error, messages, messages.operationFailed)}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(submitRegistration.error, messages)}</AlertDescription></Alert> : null}
            </FieldGroup>
          )}
        </section>
      </div>

      <section aria-labelledby="registration-records-heading" className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-semibold" id="registration-records-heading">{messages.registrationRecords}</h2><Badge variant="secondary">{registrations.data?.total ?? 0}</Badge></div>
        {registrations.isPending ? <Skeleton className="h-24 w-full" /> : registrations.isError ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{getWorkspaceErrorTitle(registrations.error, messages, messages.registrationUnavailable)}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(registrations.error, messages)}</AlertDescription></Alert> : registrations.data.items.length === 0 ? (
          <Empty className="min-h-36 border"><EmptyHeader><EmptyMedia variant="icon"><ClipboardPlusIcon aria-hidden="true" /></EmptyMedia><EmptyTitle>{messages.noRegistrations}</EmptyTitle><EmptyDescription>{messages.noRegistrationsDescription}</EmptyDescription></EmptyHeader></Empty>
        ) : (
          <div className="flex flex-col gap-2">
            <Table>
              <TableHeader><TableRow><TableHead>{messages.registrationNumber}</TableHead><TableHead>{messages.patient}</TableHead><TableHead>{messages.arrivedAt}</TableHead><TableHead>{messages.status}</TableHead></TableRow></TableHeader>
              <TableBody>{registrations.data.items.map(item => <TableRow key={item.registrationId}><TableCell className="font-medium">{item.registrationNumber}</TableCell><TableCell>{item.patient.name}</TableCell><TableCell>{new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(item.arrivedAt))}</TableCell><TableCell><Badge variant="outline">{item.status === 'awaiting-triage' ? messages.awaitingTriage : item.status}</Badge></TableCell></TableRow>)}</TableBody>
            </Table>
            <PaginationControls
              messages={messages}
              onPageChange={setRegistrationPage}
              page={registrations.data.page}
              pageSize={registrations.data.pageSize}
              total={registrations.data.total}
            />
          </div>
        )}
      </section>
    </div>
  )
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
