import { useEffect, useRef, useState, type RefObject } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { z } from 'zod'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import type {
  InpatientSurgicalConsentDocument,
  SurgicalConsentSignerRole,
  inpatientSurgeryCatalogSchema,
  inpatientSurgeryRequestSchema,
} from '@clinmesh/contracts/inpatient-surgery'
import {
  buildSurgicalConsentDocument,
  formatAnesthesiaMethod,
  formatConsentSignerRole,
  formatPractitionerDisplay,
  formatSurgeryType,
} from '@clinmesh/core/inpatient-surgery-consent'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@clinmesh/ui/components/dialog'
import { Field, FieldGroup, FieldLabel, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { apiGet } from './api-client.ts'
import { OrderComposerFooter } from './doctor/order-composer-layout.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatShanghaiMinute } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

type SurgeryRequestRow = z.infer<typeof inpatientSurgeryRequestSchema>

export interface NoticeSummaryItem {
  label: string
  value: string
  className?: string | undefined
}

export function SurgeryNoticeSummaryList({
  row,
  locale,
  includeProcedure = false,
  extraItems = [],
}: {
  row: SurgeryRequestRow
  locale: WorkspaceLocale
  includeProcedure?: boolean
  extraItems?: ReadonlyArray<NoticeSummaryItem>
}): React.JSX.Element {
  const t = (cn: string, en: string) => (locale === 'zh-CN' ? cn : en)
  const unrecorded = t('未记录', 'Not recorded')
  const surgeonDisplay = row.surgeon
    ? `${formatPractitionerDisplay(row.surgeon)}${
        row.assistant
          ? ` · ${t('第一助手：', '1st assistant: ')}${formatPractitionerDisplay(row.assistant)}`
          : ''
      }`
    : unrecorded
  const entries: NoticeSummaryItem[] = [
    { label: t('手术类型', 'Surgery type'), value: row.surgeryType ? formatSurgeryType(row.surgeryType, locale) : unrecorded },
    ...(includeProcedure
      ? [{ label: t('拟施术式', 'Planned procedure'), value: `${row.plannedProcedure.coding.code} · ${row.plannedProcedure.coding.display}` }]
      : []),
    { label: t('计划手术时间', 'Planned surgery time'), value: formatShanghaiMinute(row.plannedFor).slice(5), className: 'tabular-nums' },
    { label: t('手术执行地点', 'Surgical location'), value: row.location?.name ?? unrecorded },
    { label: t('主刀医师', 'Primary surgeon'), value: surgeonDisplay },
    { label: t('拟行麻醉方式', 'Planned anesthesia'), value: row.anesthesiaMethod ? formatAnesthesiaMethod(row.anesthesiaMethod, locale) : unrecorded },
    ...extraItems,
    { label: t('申请理由', 'Request reason'), value: row.reason },
  ]
  return (
    <dl className="grid gap-3 text-sm @lg:grid-cols-3">
      {entries.map(entry => (
        <div key={entry.label}>
          <dt className="text-xs text-muted-foreground">{entry.label}</dt>
          <dd className={entry.className}>{entry.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ConsentDocumentContent({
  document,
  locale,
  noteText,
}: {
  document: InpatientSurgicalConsentDocument
  locale: WorkspaceLocale
  noteText?: string | undefined
}): React.JSX.Element {
  const t = (cn: string, en: string) => (locale === 'zh-CN' ? cn : en)
  const unrecorded = t('未记录', 'Not recorded')
  const genderLabel = document.patient.gender === 'female'
    ? t('女', 'Female')
    : document.patient.gender === 'male'
      ? t('男', 'Male')
      : document.patient.gender === 'other'
        ? t('其他', 'Other')
        : unrecorded
  const diagnosisText = document.primaryDiagnosis
    ? `${document.primaryDiagnosis.code} ${document.primaryDiagnosis.display}`
    : t('尚未确认住院主诊断', 'Primary inpatient diagnosis not yet confirmed')
  const surgeryTypeText = document.surgeryNotice.surgeryType
    ? formatSurgeryType(document.surgeryNotice.surgeryType, locale)
    : unrecorded
  const anesthesiaText = document.surgeryNotice.anesthesiaMethod
    ? formatAnesthesiaMethod(document.surgeryNotice.anesthesiaMethod, locale)
    : unrecorded
  const signerRoleLabel = formatConsentSignerRole(document.signature.signerRole, locale)
  const signerDetail = document.signature.signerRole === 'family-proxy' && document.signature.signerRelationship
    ? `${document.signature.signerName}（${document.signature.signerRelationship}）`
    : document.signature.signerName

  return (
    <article aria-label={document.title} className="flex flex-col gap-3 rounded-md border border-border bg-muted/20 p-3.5 text-sm">
      <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs font-medium text-foreground">
        {document.disclaimer}
      </p>
      <header className="flex flex-col gap-0.5 border-b pb-2">
        <h4 className="text-base font-semibold">{document.title}</h4>
        <span className="text-xs text-muted-foreground">
          {t('一术一议结构化告知文书', 'Procedure-specific structured informed consent')}
        </span>
      </header>
      <section className="flex flex-col gap-1.5">
        <h5 className="font-semibold">{t('一、患者与拟施手术信息', '1. Patient & planned procedure')}</h5>
        <dl className="grid gap-2 sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">{t('患者姓名', 'Patient name')}</dt><dd>{document.patient.name}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('性别 / 出生日期', 'Gender / birth date')}</dt><dd>{genderLabel} · {document.patient.birthDate ?? unrecorded}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('住院号', 'Inpatient no.')}</dt><dd className="font-mono text-xs">{document.patient.inpatientNumber}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('住院主诊断', 'Primary diagnosis')}</dt><dd>{diagnosisText}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('手术类型', 'Surgery type')}</dt><dd>{surgeryTypeText}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('拟施术式', 'Planned procedure')}</dt><dd>{document.surgeryNotice.procedureCode} · {document.surgeryNotice.procedureDisplay}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('计划手术时间', 'Planned surgery time')}</dt><dd className="tabular-nums">{formatShanghaiMinute(document.surgeryNotice.plannedFor)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('手术执行地点', 'Surgical location')}</dt><dd>{document.surgeryNotice.locationName ?? unrecorded}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('主刀医师', 'Primary surgeon')}</dt><dd>{document.surgeryNotice.surgeonName ?? unrecorded}{document.surgeryNotice.assistantName ? ` · ${t('第一助手：', '1st assistant: ')}${document.surgeryNotice.assistantName}` : ''}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('拟行麻醉方式', 'Planned anesthesia')}</dt><dd>{anesthesiaText}</dd></div>
        </dl>
      </section>
      <section className="flex flex-col gap-1">
        <h5 className="font-semibold">{t('二、手术目的与简要方法', '2. Purpose & brief method')}</h5>
        <p className="leading-relaxed text-foreground">{document.purposeAndMethod}</p>
      </section>
      <section className="flex flex-col gap-1">
        <h5 className="font-semibold">{t('三、常见风险与并发症告知', '3. Common risks & complications')}</h5>
        <ol className="list-decimal space-y-1 pl-5 leading-relaxed">
          {document.commonRisks.map((clause, idx) => (
            <li key={idx}>{clause}</li>
          ))}
        </ol>
      </section>
      <section className="flex flex-col gap-1">
        <h5 className="font-semibold">{t('四、个体化特别风险说明', '4. Individualized special risks')}</h5>
        <p className="leading-relaxed">
          {document.individualizedRisks ?? t('无额外补充特殊风险条款。', 'No additional individualized risks.')}
        </p>
      </section>
      <section className="flex flex-col gap-1">
        <h5 className="font-semibold">{t('五、替代医疗方案', '5. Alternative treatment plans')}</h5>
        <p className="leading-relaxed">{document.alternativePlans}</p>
      </section>
      <section className="flex flex-col gap-1.5 border-t pt-2">
        <h5 className="font-semibold">{t('六、知情选择与签署确认', '6. Informed choice & signature confirmation')}</h5>
        <p className="leading-relaxed">{document.patientChoiceStatement}</p>
        <dl className="grid gap-2 pt-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-muted-foreground">{t('签署方', 'Signer')}</dt>
            <dd className="font-medium text-foreground">{signerRoleLabel} · {signerDetail}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('谈话医师', 'Talking physician')}</dt>
            <dd className="font-medium text-foreground">{document.signature.talkingDoctorName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">{t('确认时间', 'Confirmed at')}</dt>
            <dd className="font-medium tabular-nums text-foreground">{formatShanghaiMinute(document.signature.signedAt)}</dd>
          </div>
        </dl>
        {noteText ? (
          <p className="text-xs text-muted-foreground">{t('签署摘要：', 'Summary: ')}{noteText}</p>
        ) : null}
      </section>
    </article>
  )
}

export function SurgicalConsentPreviewButton({
  admission,
  request,
  locale,
}: {
  admission: InpatientAdmission
  request: SurgeryRequestRow
  locale: WorkspaceLocale
}): React.JSX.Element | null {
  const t = (cn: string, en: string) => (locale === 'zh-CN' ? cn : en)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const confirmation = request.consentConfirmation
  if (!confirmation) return null
  const title = confirmation.document?.title ?? t('手术知情同意书', 'Surgical informed consent')

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={<Button ref={triggerRef} type="button" variant="outline" size="sm" />}
      >
        {t('查看知情同意书', 'View surgical consent')}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100%-2rem)] sm:max-w-[760px]" finalFocus={triggerRef}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{admission.patientName} · {request.plannedProcedure.coding.display}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {confirmation.document ? (
            <ConsentDocumentContent document={confirmation.document} locale={locale} noteText={confirmation.note} />
          ) : (
            <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/20 p-3.5 text-sm">
              <p className="text-muted-foreground">
                {t('该历史记录仅登记纸质知情同意书签署说明，未保存结构化同意书正文。', 'This legacy record only stores a brief consent note without a structured consent document.')}
              </p>
              <p>{t('说明：', 'Note: ')}{confirmation.note}</p>
              <p className="text-xs tabular-nums text-muted-foreground">
                {t('登记时间：', 'Recorded at: ')}{formatShanghaiMinute(confirmation.recordedAt)}
              </p>
            </div>
          )}
        </div>
        <OrderComposerFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>
            {t('关闭', 'Close')}
          </DialogClose>
        </OrderComposerFooter>
      </DialogContent>
    </Dialog>
  )
}

const PROXY_RELATIONSHIP_PRESETS: ReadonlyArray<readonly [string, string]> = [
  ['配偶', 'Spouse'],
  ['子女', 'Child'],
  ['父母', 'Parent'],
  ['其他受托人', 'Other proxy'],
]

export function SurgicalConsentSignDialog({
  admission,
  session,
  request,
  catalog,
  virtualTime,
  locale,
  write,
  blocked,
  open,
  onOpenChange,
  returnFocus,
}: {
  admission: InpatientAdmission
  session: SessionContext
  request: SurgeryRequestRow
  catalog?: z.infer<typeof inpatientSurgeryCatalogSchema> | undefined
  virtualTime: string
  locale: WorkspaceLocale
  write: ReturnType<typeof useInpatientWriteIntent>
  blocked: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocus?: RefObject<HTMLElement | null> | undefined
}): React.JSX.Element {
  const t = (cn: string, en: string) => (locale === 'zh-CN' ? cn : en)
  const [signerRole, setSignerRole] = useState<SurgicalConsentSignerRole>('patient')
  const [signerName, setSignerName] = useState(admission.patientName)
  const [signerRelationship, setSignerRelationship] = useState('')
  const [individualizedRisks, setIndividualizedRisks] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    setSignerRole('patient')
    setSignerName(admission.patientName)
    setSignerRelationship('')
    setIndividualizedRisks('')
    setNote('')
  }, [admission.id, admission.patientName, request.id])

  const clinical = useQuery({
    queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, admission.id, 'clinical'],
    enabled: open && session.actor.roleCode === 'inpatient-doctor',
    retry: false,
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/clinical`, inpatientFullClinicalSchema, signal),
  })

  const primaryEntry = clinical.data?.diagnosis.entries.find(entry => entry.role === 'primary')
  const talkingDoctorId = session.actor.practitionerId ?? 'practitioner-inpatient-doctor'
  const talkingDoctor = catalog?.practitioners.find(item => item.id === talkingDoctorId)
  const fallbackDoctorName = session.availableRoles.find(role => role.id === session.actor.practitionerRoleId)?.practitionerName ?? session.user.name
  const talkingDoctorName = talkingDoctor ? formatPractitionerDisplay(talkingDoctor) : fallbackDoctorName
  const previewDocument = buildSurgicalConsentDocument({
    patient: {
      name: admission.patientName,
      gender: admission.patientGender ?? 'unknown',
      birthDate: admission.patientBirthDate ?? null,
      inpatientNumber: admission.inpatientNumber,
    },
    primaryDiagnosis: primaryEntry
      ? { code: primaryEntry.coding.code, display: primaryEntry.coding.display }
      : null,
    surgeryNotice: {
      surgeryType: request.surgeryType ?? null,
      procedureCode: request.plannedProcedure.coding.code,
      procedureDisplay: request.plannedProcedure.coding.display,
      plannedFor: request.plannedFor,
      locationName: request.location?.name ?? null,
      anesthesiaMethod: request.anesthesiaMethod ?? null,
      surgeonName: request.surgeon ? formatPractitionerDisplay(request.surgeon) : null,
      assistantName: request.assistant ? formatPractitionerDisplay(request.assistant) : null,
    },
    individualizedRisks,
    signature: {
      signerRole,
      signerName: signerName.trim() || admission.patientName,
      signerRelationship: signerRole === 'family-proxy' ? (signerRelationship.trim() || '待填写') : null,
      talkingDoctorId,
      talkingDoctorName,
      signedAt: virtualTime,
    },
  })

  const isPending = write.mutation.isPending
    && write.mutation.variables?.operation === 'inpatient.surgery.confirm-consent'
    && write.mutation.variables.input.admissionId === admission.id
    && write.mutation.variables.input.requestId === request.id
  const ownError = write.mutation.error
    && write.mutation.variables?.operation === 'inpatient.surgery.confirm-consent'
    && write.mutation.variables.input.admissionId === admission.id
    && write.mutation.variables.input.requestId === request.id
    ? write.mutation.error
    : null

  const clinicalNotReady = clinical.isPending || Boolean(clinical.error)
  const missingSignerName = signerName.trim().length === 0
  const missingRelationship = signerRole === 'family-proxy' && signerRelationship.trim().length === 0
  const submitDisabled = blocked || clinicalNotReady || missingSignerName || missingRelationship
  const formId = `surgery-consent-form-${request.id}`

  const submit = () => {
    if (submitDisabled) return
    write.mutation.mutate(
      {
        operation: 'inpatient.surgery.confirm-consent',
        input: {
          admissionId: admission.id,
          requestId: request.id,
          expectedRequestVersion: request.version,
          signerRole,
          signerName: signerName.trim(),
          ...(signerRole === 'family-proxy' ? { signerRelationship: signerRelationship.trim() } : {}),
          patientChoice: 'agree',
          ...(individualizedRisks.trim() ? { individualizedRisks: individualizedRisks.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      },
      { onSuccess: () => onOpenChange(false) },
    )
  }

  const footerHint = clinical.isPending
    ? t('正在读取住院诊断信息…', 'Loading inpatient diagnosis…')
    : clinical.error
      ? t('请先加载住院诊断信息后再核对签署', 'Load inpatient diagnosis before confirming signing')
      : missingSignerName
        ? t('还差：填写签署人姓名', 'Enter the signer name')
        : missingRelationship
          ? t('还差：填写与患者关系', 'Enter the relationship to patient')
          : t('核对全文后登记患者签署与谈话医师确认', 'Review the full document and confirm signing')

  return (
    <Dialog open={open} pending={isPending} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[calc(100%-2rem)] sm:max-w-[780px]"
        showCloseButton={!isPending}
        finalFocus={returnFocus}
      >
        <DialogHeader>
          <DialogTitle>{t('手术知情同意书', 'Surgical informed consent')}</DialogTitle>
          <DialogDescription>{admission.patientName} · {request.plannedProcedure.coding.display}</DialogDescription>
        </DialogHeader>
        <form id={formId} className="flex min-h-0 flex-1 flex-col p-0" onSubmit={(event) => { event.preventDefault(); submit() }}>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {ownError ? (
              <Alert variant="destructive">
                <AlertDescription>{getWorkspaceErrorMessage(ownError, getWorkspaceMessages(locale))}</AlertDescription>
              </Alert>
            ) : null}
            {clinical.isPending ? (
              <Skeleton className="h-48 w-full" />
            ) : clinical.error ? (
              <Alert variant="destructive">
                <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                  <span>{t('住院诊断读取失败：', 'Inpatient diagnosis failed to load: ')}{getWorkspaceErrorMessage(clinical.error, getWorkspaceMessages(locale))}</span>
                  <Button type="button" variant="outline" size="sm" onClick={() => void clinical.refetch()}>{t('重试诊断信息', 'Retry diagnosis')}</Button>
                </AlertDescription>
              </Alert>
            ) : (
              <ConsentDocumentContent document={previewDocument} locale={locale} />
            )}
            <FieldSet disabled={blocked}>
              <FieldGroup className="grid gap-3 md:grid-cols-2">
                <Field className="md:col-span-2">
                  <FieldLabel htmlFor={`${formId}-risks`}>{t('个体化特别风险说明', 'Individualized special risks')}</FieldLabel>
                  <Textarea
                    id={`${formId}-risks`}
                    rows={2}
                    maxLength={2000}
                    placeholder={t('按患者合并症或个体高危情况补充说明（选填）', 'Add patient-specific risk disclosures if applicable (optional)')}
                    value={individualizedRisks}
                    onChange={event => setIndividualizedRisks(event.currentTarget.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${formId}-role`}>{t('签署人身份', 'Signer role')}</FieldLabel>
                  <WorkspaceSelect
                    id={`${formId}-role`}
                    value={signerRole}
                    items={[
                      { value: 'patient', label: formatConsentSignerRole('patient', locale) },
                      { value: 'family-proxy', label: formatConsentSignerRole('family-proxy', locale) },
                    ]}
                    onValueChange={(value) => {
                      const nextRole: SurgicalConsentSignerRole = value === 'family-proxy' ? 'family-proxy' : 'patient'
                      setSignerRole(nextRole)
                      if (nextRole === 'patient') {
                        setSignerName(admission.patientName)
                        setSignerRelationship('')
                      } else if (signerName === admission.patientName) {
                        setSignerName('')
                      }
                    }}
                  />
                </Field>
                <Field data-invalid={missingSignerName || undefined}>
                  <FieldLabel htmlFor={`${formId}-signer`}>{t('签署人姓名', 'Signer name')}</FieldLabel>
                  <Input
                    id={`${formId}-signer`}
                    maxLength={80}
                    value={signerName}
                    onChange={event => setSignerName(event.currentTarget.value)}
                  />
                </Field>
                {signerRole === 'family-proxy' ? (
                  <Field className="md:col-span-2" data-invalid={missingRelationship || undefined}>
                    <FieldLabel htmlFor={`${formId}-relation`}>{t('与患者关系', 'Relationship to patient')}</FieldLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {PROXY_RELATIONSHIP_PRESETS.map(([zhLabel, enLabel]) => {
                        const preset = t(zhLabel, enLabel)
                        return (
                          <Button
                            key={preset}
                            type="button"
                            variant="outline"
                            size="sm"
                            disabled={blocked}
                            onClick={() => setSignerRelationship(preset)}
                          >
                            {preset}
                          </Button>
                        )
                      })}
                    </div>
                    <Input
                      id={`${formId}-relation`}
                      maxLength={40}
                      placeholder={t('如：配偶、子女、父母', 'e.g. Spouse, Child, Parent')}
                      value={signerRelationship}
                      onChange={event => setSignerRelationship(event.currentTarget.value)}
                    />
                  </Field>
                ) : null}
                <Field className="md:col-span-2">
                  <FieldLabel htmlFor={`${formId}-note`}>{t('签署备注', 'Signing note')}</FieldLabel>
                  <Input
                    id={`${formId}-note`}
                    maxLength={2000}
                    placeholder={t('补充谈话或签署说明（选填）', 'Additional signing remarks (optional)')}
                    value={note}
                    onChange={event => setNote(event.currentTarget.value)}
                  />
                </Field>
              </FieldGroup>
            </FieldSet>
          </div>
          <OrderComposerFooter hint={footerHint}>
            <Button type="button" variant="outline" disabled={isPending} onClick={() => onOpenChange(false)}>
              {t('取消', 'Cancel')}
            </Button>
            <Button
              type="submit"
              aria-busy={isPending || undefined}
              data-busy={isPending || undefined}
              data-unavailable={(!isPending && submitDisabled) || undefined}
              disabled={submitDisabled || isPending}
            >
              {isPending ? <Spinner aria-hidden="true" data-icon="inline-start" /> : null}
              {isPending ? t('正在确认知情同意书', 'Confirming signed consent') : t('确认手术知情同意书已签', 'Confirm signed consent')}
            </Button>
          </OrderComposerFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
