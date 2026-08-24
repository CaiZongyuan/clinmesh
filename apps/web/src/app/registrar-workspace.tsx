import type { PatientSummary, SessionContext } from '@clinmesh/contracts/his'
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
import { CheckIcon, CircleAlertIcon, ClipboardPlusIcon, SearchIcon, UserPlusIcon } from 'lucide-react'
import { useState } from 'react'
import {
  createSyntheticPatient,
  getRegistrationCatalog,
  getRegistrationQueue,
  newIdempotencyKey,
  registerOutpatient,
  searchPatients,
} from './api-client.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { PaginationControls } from './pagination-controls.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

interface RegistrarWorkspaceProps {
  locale: WorkspaceLocale
  session: SessionContext
}

const genderValues = ['male', 'female', 'other', 'unknown'] as const

export function RegistrarWorkspace({ locale, session }: RegistrarWorkspaceProps): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const scope = [session.actor.workspaceId, session.actor.epoch] as const
  const [patientQuery, setPatientQuery] = useState('')
  const [submittedQuery, setSubmittedQuery] = useState('')
  const [patientPage, setPatientPage] = useState(1)
  const [registrationPage, setRegistrationPage] = useState(1)
  const [selectedPatient, setSelectedPatient] = useState<PatientSummary>()
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
  const registrationsKey = ['registration-queue', ...scope, registrationPage] as const
  const registrations = useQuery({
    queryFn: ({ signal }) => getRegistrationQueue(signal, registrationPage),
    queryKey: registrationsKey,
  })
  const patients = useQuery({
    enabled: submittedQuery !== '',
    queryFn: ({ signal }) => searchPatients(submittedQuery, signal, patientPage),
    queryKey: ['patient-search', ...scope, submittedQuery, patientPage],
  })
  const createPatient = useMutation({
    mutationFn: () => createSyntheticPatient({ birthDate, gender, identifier, name }, newIdempotencyKey()),
    onSuccess: response => {
      setSelectedPatient(response.data.patient)
      setName('')
      setIdentifier('')
    },
  })
  const register = useMutation({
    mutationFn: () => {
      if (selectedPatient === undefined || catalog.data === undefined) {
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
      return registerOutpatient({
        departmentId: resolvedDepartmentId,
        locationId: resolvedLocationId,
        patientId: selectedPatient.id,
        patientVersion: selectedPatient.versionId,
        visitDate: catalog.data.virtualDate,
        visitTypeId: resolvedVisitTypeId,
      }, newIdempotencyKey())
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: registrationsKey })
    },
  })

  const resolvedDepartmentId = departmentId || catalog.data?.departments[0]?.id || ''
  const resolvedLocationId = locationId || catalog.data?.locations[0]?.id || ''
  const resolvedVisitTypeId = visitTypeId || catalog.data?.visitTypes[0]?.id || ''
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

  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(18rem,0.9fr)_minmax(24rem,1.25fr)]">
        <section aria-labelledby="patient-heading" className="flex min-w-0 flex-col gap-4 border-b pb-6 xl:border-r xl:border-b-0 xl:pr-6">
          <h2 className="text-base font-semibold" id="patient-heading">{messages.patientSelection}</h2>
          <Tabs defaultValue="search">
            <TabsList>
              <TabsTrigger value="search"><SearchIcon data-icon="inline-start" />{messages.searchPatient}</TabsTrigger>
              <TabsTrigger value="create"><UserPlusIcon data-icon="inline-start" />{messages.createSyntheticPatientTab}</TabsTrigger>
            </TabsList>
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
                        {patients.data.items.map(patient => (
                          <TableRow key={patient.id}>
                            <TableCell>{patient.name}</TableCell>
                            <TableCell>{patient.identifier}</TableCell>
                            <TableCell className="text-right">
                              <Button
                                aria-label={`${messages.selectPatient} ${patient.name}`}
                                onClick={() => setSelectedPatient(patient)}
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                              ><CheckIcon /></Button>
                            </TableCell>
                          </TableRow>
                        ))}
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
                  <Field><FieldLabel htmlFor="patient-identifier">{messages.syntheticIdentifier}</FieldLabel><Input id="patient-identifier" onChange={event => setIdentifier(event.currentTarget.value)} required value={identifier} /></Field>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field><FieldLabel htmlFor="patient-birth-date">{messages.birthDate}</FieldLabel><Input id="patient-birth-date" onChange={event => setBirthDate(event.currentTarget.value)} required type="date" value={birthDate} /></Field>
                    <Field>
                      <FieldLabel htmlFor="patient-gender">{messages.gender}</FieldLabel>
                      <WorkspaceSelect id="patient-gender" items={genderItems} onValueChange={value => setGender(value as typeof gender)} value={gender} />
                    </Field>
                  </div>
                  <Button disabled={createPatient.isPending} type="submit"><UserPlusIcon data-icon="inline-start" />{messages.createPatient}</Button>
                  {createPatient.isError ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{getWorkspaceErrorTitle(createPatient.error, messages, messages.operationFailed)}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(createPatient.error, messages)}</AlertDescription></Alert> : null}
                </FieldGroup>
              </form>
            </TabsContent>
          </Tabs>
          {selectedPatient === undefined ? null : (
            <Alert>
              <CheckIcon aria-hidden="true" />
              <AlertTitle>{messages.selectedPatient}</AlertTitle>
              <AlertDescription>{messages.selectedPrefix}{selectedPatient.name}</AlertDescription>
            </Alert>
          )}
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
                <span className="text-sm text-muted-foreground">{selectedPatient?.name ?? messages.selectPatientFirst}</span>
                <Button disabled={selectedPatient === undefined || register.isPending} onClick={() => register.mutate()} type="button"><ClipboardPlusIcon data-icon="inline-start" />{messages.confirmRegistration}</Button>
              </div>
              {register.isSuccess ? <Alert><CheckIcon aria-hidden="true" /><AlertTitle>{messages.registrationCompleted}</AlertTitle><AlertDescription>{messages.awaitingTriage}</AlertDescription></Alert> : null}
              {register.isError ? <Alert variant="destructive"><CircleAlertIcon aria-hidden="true" /><AlertTitle>{getWorkspaceErrorTitle(register.error, messages, messages.operationFailed)}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(register.error, messages)}</AlertDescription></Alert> : null}
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
