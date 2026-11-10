import type { SessionContext } from '@clinmesh/contracts/his'
import type { SyntheticPatientProfileDetail } from '@clinmesh/contracts/scenario'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@clinmesh/ui/components/sheet'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { UserPlusIcon } from 'lucide-react'
import { useRef } from 'react'
import { getRegistrationCatalog } from './api-client.ts'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { patientLibraryScope, usePatientLibraryVisitState, type PatientLibraryContinuation } from './patient-library-visit-state.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

export function StartCaseVisitSheet({ locale, onOpenChange, open, profileId, syntheticCase, session, continuation }: {
  locale: WorkspaceLocale; onOpenChange: (open: boolean) => void; open: boolean; profileId: string; session: SessionContext
  syntheticCase: NonNullable<SyntheticPatientProfileDetail['case']>; continuation: PatientLibraryContinuation
}) {
  const zh = locale === 'zh-CN'
  const title = zh ? '开始门诊就诊' : 'Start outpatient visit'
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const scope = patientLibraryScope(session)
  const current = useRef(open)
  current.current = open
  const { state, saveDraft } = usePatientLibraryVisitState(session, { profileId, caseId: syntheticCase.caseId })
  const catalog = useQuery({ enabled: open, queryFn: ({ signal }) => getRegistrationCatalog(signal), queryKey: ['registration-catalog', scope] })
  const departmentId = state.draft.departmentId || catalog.data?.departments[0]?.id || ''
  const locationId = state.draft.locationId || catalog.data?.locations[0]?.id || ''
  const visitTypeId = state.draft.visitTypeId || catalog.data?.visitTypes[0]?.id || ''
  const write = useInpatientWriteIntent(session, async command => {
    if (command.operation !== 'registration.synthetic-case.start' || command.input.caseId !== syntheticCase.caseId) return
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['synthetic-patient-profile', profileId, scope] }),
      queryClient.invalidateQueries({ queryKey: ['synthetic-patient-profiles', scope] }),
    ])
    onOpenChange(false)
  })
  const pending = write.pending?.command.operation === 'registration.synthetic-case.start' ? write.pending.command : undefined
  const ownPending = pending?.input.caseId === syntheticCase.caseId
  const error = state.error ?? write.storageFailure ?? write.mutation.error
  const valid = catalog.data?.departments.some(item => item.id === departmentId) && catalog.data.locations.some(item => item.id === locationId)
    && catalog.data.visitTypes.some(item => item.id === visitTypeId)
  const start = () => {
    if (!valid || catalog.data === undefined || syntheticCase.activeBriefRevision === null || state.error !== null || write.blocked) return
    write.mutation.mutate({ operation: 'registration.synthetic-case.start', continuation, isCurrent: () => current.current,
      input: { caseId: syntheticCase.caseId, activeBriefRevision: syntheticCase.activeBriefRevision, expectedCaseRevision: syntheticCase.revision,
        departmentId, locationId, visitTypeId, visitDate: catalog.data.virtualDate } })
  }
  return <Sheet onOpenChange={value => { if (value || !write.mutation.isPending) onOpenChange(value) }} open={open}>
    <SheetContent className="w-full sm:max-w-md" side="right">
      <SheetHeader><SheetTitle>{title}</SheetTitle><SheetDescription>{continuation.current.name} · {zh ? '核对就诊科室、地点及门诊类型后确认。' : 'Review the department, location and visit type before confirming.'}</SheetDescription></SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4">
        {catalog.isPending ? <Skeleton className="h-28 w-full" /> : catalog.isError ? <Alert variant="destructive"><AlertTitle>{zh ? '挂号目录读取失败' : 'Could not load registration options'}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(catalog.error, messages)}</AlertDescription><Button onClick={() => void catalog.refetch()} variant="outline">{zh ? '重试挂号目录' : 'Retry registration options'}</Button></Alert> : catalog.data === undefined ? null : <FieldGroup>
          <Field><FieldLabel htmlFor="case-visit-department">{zh ? '就诊科室' : 'Department'}</FieldLabel><WorkspaceSelect id="case-visit-department" disabled={write.blocked} value={departmentId} items={catalog.data.departments.map(item => ({ value: item.id, label: zh ? item.nameZh : item.nameEn }))} onValueChange={value => saveDraft({ ...state.draft, departmentId: value ?? '' })} /></Field>
          <Field><FieldLabel htmlFor="case-visit-location">{zh ? '就诊地点' : 'Location'}</FieldLabel><WorkspaceSelect id="case-visit-location" disabled={write.blocked} value={locationId} items={catalog.data.locations.map(item => ({ value: item.id, label: zh ? item.nameZh : item.nameEn }))} onValueChange={value => saveDraft({ ...state.draft, locationId: value ?? '' })} /></Field>
          <Field><FieldLabel htmlFor="case-visit-type">{zh ? '门诊类型' : 'Visit type'}</FieldLabel><WorkspaceSelect id="case-visit-type" disabled={write.blocked} value={visitTypeId} items={catalog.data.visitTypes.map(item => ({ value: item.id, label: zh ? item.nameZh : item.nameEn }))} onValueChange={value => saveDraft({ ...state.draft, visitTypeId: value ?? '' })} /></Field>
        </FieldGroup>}
        {pending === undefined ? null : <Alert><AlertTitle>{zh ? '原门诊开始结果待确认' : 'Original outpatient start needs recovery'}</AlertTitle><AlertDescription>{pending.continuation.current.name}</AlertDescription>{ownPending ? <Button disabled={write.mutation.isPending || write.storageFailure !== null} onClick={() => write.mutation.mutate(undefined)} variant="outline">{zh ? '查询原门诊开始结果' : 'Recover original outpatient start'}</Button> : null}</Alert>}
        {error === null ? null : <Alert variant="destructive"><AlertTitle>{zh ? '门诊就诊启动失败' : 'Could not start the outpatient visit'}</AlertTitle><AlertDescription>{getWorkspaceErrorMessage(error, messages)}</AlertDescription></Alert>}
      </div>
      <SheetFooter><Button disabled={!valid || catalog.isFetching || state.error !== null || write.blocked} onClick={start}><UserPlusIcon aria-hidden="true" data-icon="inline-start" />{title}</Button></SheetFooter>
    </SheetContent>
  </Sheet>
}
