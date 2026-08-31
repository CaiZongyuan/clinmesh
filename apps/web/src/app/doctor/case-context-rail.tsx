import type { DoctorCaseDetail, EncounterCompletionPreview } from '@clinmesh/contracts/his'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { PanelRightCloseIcon, PanelRightOpenIcon } from 'lucide-react'
import { getWorkspaceMessages, type WorkspaceLocale } from '../workspace-i18n.ts'

export type DoctorCaseSection = 'consultation' | 'record' | 'diagnosis' | 'prescription' | 'laboratory'

const copy = {
  'en-US': {
    availableQuestions: 'Available questions',
    confirmed: 'Confirmed',
    consultationContext: 'Consultation overview',
    diagnosisContext: 'Diagnosis overview',
    diagnosisEntries: (count: number) => `${count} diagnoses`,
    draftAvailable: 'Draft saved',
    laboratoryContext: 'Laboratory overview',
    laboratoryRequests: (count: number) => `${count} requests`,
    medicalRecordContext: 'Medical record overview',
    noPendingReports: 'No reports awaiting acknowledgement',
    noMedication: 'No medication',
    notRecorded: 'Not recorded',
    pendingReports: (count: number) => `${count} reports awaiting acknowledgement`,
    prescriptionContext: 'Prescription overview',
    questionCount: (count: number) => `${count} questions`,
    recordCount: (count: number) => `${count} records`,
    reportAbnormalities: (count: number) => `${count} abnormal results`,
    signedVersions: (count: number) => `${count} signed versions`,
    vitalSigns: 'Vital signs',
    complete: 'Complete',
    incomplete: 'Incomplete',
  },
  'zh-CN': {
    availableQuestions: '可提问项',
    confirmed: '已确认',
    consultationContext: '问诊概况',
    diagnosisContext: '诊断概况',
    diagnosisEntries: (count: number) => `${count} 条诊断`,
    draftAvailable: '草稿已保存',
    laboratoryContext: '检验概况',
    laboratoryRequests: (count: number) => `${count} 项申请`,
    medicalRecordContext: '病历概况',
    noPendingReports: '暂无待阅报告',
    noMedication: '无需用药',
    notRecorded: '尚未记录',
    pendingReports: (count: number) => `${count} 份待阅报告`,
    prescriptionContext: '处方概况',
    questionCount: (count: number) => `${count} 项`,
    recordCount: (count: number) => `${count} 条记录`,
    reportAbnormalities: (count: number) => `${count} 项异常结果`,
    signedVersions: (count: number) => `${count} 个签署版本`,
    vitalSigns: '生命体征',
    complete: '已完成',
    incomplete: '待完成',
  },
} as const

type WorkspaceMessages = ReturnType<typeof getWorkspaceMessages>

function ContextFact({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{value}</dd>
    </div>
  )
}

function isAbnormalInterpretation(interpretation: string | undefined): boolean {
  if (interpretation === undefined) return false
  return !['n', 'neg', 'negative', 'normal'].includes(interpretation.trim().toLowerCase())
}

function prescriptionStatus(
  detail: DoctorCaseDetail,
  messages: WorkspaceMessages,
  labels: { draftAvailable: string; noMedication: string; notRecorded: string },
): string {
  const conclusion = detail.medicationConclusion
  if (conclusion?.noMedication !== undefined) return labels.noMedication
  const prescription = conclusion?.prescription
  if (prescription === undefined) {
    return conclusion?.draft === undefined ? labels.notRecorded : labels.draftAvailable
  }
  if (prescription.status === 'signed') return messages.prescriptionStatus_signed
  if (prescription.status === 'paid') return messages.prescriptionStatus_paid
  if (prescription.status === 'dispensed') return messages.prescriptionStatus_dispensed
  return messages.prescriptionStatus_withdrawn
}

function PageContext({ detail, locale, messages, section }: {
  detail: DoctorCaseDetail
  locale: WorkspaceLocale
  messages: WorkspaceMessages
  section: DoctorCaseSection
}): React.JSX.Element {
  const labels = copy[locale]
  const headingId = `case-page-context-heading-${detail.caseId}`
  if (section === 'consultation') {
    const consultation = detail.consultation
    return (
      <section aria-labelledby={headingId}>
        <h3 className="text-sm font-semibold" id={headingId}>{labels.consultationContext}</h3>
        <dl className="mt-2 grid grid-cols-2 gap-3">
          <ContextFact label={messages.consultationRecord} value={labels.recordCount(consultation?.records.length ?? 0)} />
          <ContextFact label={labels.availableQuestions} value={labels.questionCount(consultation?.questions.length ?? 0)} />
        </dl>
      </section>
    )
  }
  if (section === 'record') {
    const document = detail.clinicalDocument
    return (
      <section aria-labelledby={headingId}>
        <h3 className="text-sm font-semibold" id={headingId}>{labels.medicalRecordContext}</h3>
        <dl className="mt-2 grid grid-cols-2 gap-3">
          <ContextFact
            label={messages.documentVersion}
            value={document?.draft === undefined ? labels.notRecorded : labels.draftAvailable}
          />
          <ContextFact
            label={messages.signedClinicalDocumentHistory}
            value={labels.signedVersions(document?.signed.length ?? 0)}
          />
        </dl>
      </section>
    )
  }
  if (section === 'diagnosis') {
    const diagnosis = detail.diagnosis
    const confirmedEntries = diagnosis?.confirmation?.entries ?? []
    const primary = confirmedEntries.find(entry => entry.role === 'primary')
    const draftPrimary = diagnosis?.draft?.entries.find(entry => entry.role === 'primary')
    const draftPrimaryLocal = diagnosis?.draft === undefined
      ? undefined
      : draftPrimary?.referenceConcept?.display ?? draftPrimary?.catalogItemId
    const status = diagnosis?.draft !== undefined
      ? labels.draftAvailable
      : diagnosis?.confirmation === undefined ? labels.notRecorded : labels.confirmed
    return (
      <section aria-labelledby={headingId}>
        <h3 className="text-sm font-semibold" id={headingId}>{labels.diagnosisContext}</h3>
        <dl className="mt-2 flex flex-col gap-3">
          <ContextFact label={messages.status} value={status} />
          <ContextFact
            label={messages.primaryDiagnosis}
            value={draftPrimaryLocal
              ?? primary?.display
              ?? labels.diagnosisEntries(diagnosis?.draft?.entries.length ?? 0)}
          />
        </dl>
      </section>
    )
  }
  if (section === 'prescription') {
    const conclusion = detail.medicationConclusion
    const itemCount = conclusion?.prescription?.items.length ?? conclusion?.draft?.items.length ?? 0
    return (
      <section aria-labelledby={headingId}>
        <h3 className="text-sm font-semibold" id={headingId}>{labels.prescriptionContext}</h3>
        <dl className="mt-2 grid grid-cols-2 gap-3">
          <ContextFact
            label={messages.medicationConclusion}
            value={prescriptionStatus(detail, messages, labels)}
          />
          <ContextFact label={messages.medication} value={labels.questionCount(itemCount)} />
        </dl>
      </section>
    )
  }

  const requests = detail.laboratoryRequests?.requests ?? []
  const pendingReports = requests.filter(request => request.status === 'reported').length
  const reportResults = requests.flatMap(request => request.report?.results ?? [])
  const legacyReport = detail.report
  const abnormalResults = [...reportResults, ...(legacyReport?.results ?? [])]
    .filter(result => isAbnormalInterpretation(result.interpretation)).length
  return (
    <section aria-labelledby={headingId}>
      <h3 className="text-sm font-semibold" id={headingId}>{labels.laboratoryContext}</h3>
      <dl className="mt-2 flex flex-col gap-3">
        {legacyReport === undefined ? (
          <ContextFact label={messages.laboratoryRequestStatus} value={labels.laboratoryRequests(requests.length)} />
        ) : null}
        <ContextFact
          label={messages.laboratoryReport}
          value={legacyReport?.status
            ?? (pendingReports === 0 ? labels.noPendingReports : labels.pendingReports(pendingReports))}
        />
        {abnormalResults === 0 ? null : (
          <ContextFact label={messages.result} value={labels.reportAbnormalities(abnormalResults)} />
        )}
      </dl>
    </section>
  )
}

export function DoctorCaseContextRail({
  completion,
  detail,
  expanded,
  locale,
  messages,
  onExpandedChange,
  section,
  statusText,
}: {
  completion: EncounterCompletionPreview | undefined
  detail: DoctorCaseDetail
  expanded: boolean
  locale: WorkspaceLocale
  messages: WorkspaceMessages
  onExpandedChange: (expanded: boolean) => void
  section: DoctorCaseSection
  statusText: string
}): React.JSX.Element {
  const labels = copy[locale]
  const vitalSigns = detail.presentation.vitalSigns
  const completionCount = completion?.items.filter(item => item.status === 'complete').length ?? 0
  return (
    <aside
      aria-label={messages.caseContext}
      className="flex min-w-0 flex-col border-t bg-muted/15 2xl:border-t-0 2xl:border-l"
    >
      <div className="flex items-center gap-2 p-2">
        <Button
          aria-expanded={expanded}
          aria-label={expanded ? messages.closeRightSidebar : messages.openRightSidebar}
          onClick={() => onExpandedChange(!expanded)}
          size="icon-sm"
          title={expanded ? messages.closeRightSidebar : messages.openRightSidebar}
          type="button"
          variant="ghost"
        >
          {expanded
            ? <PanelRightCloseIcon aria-hidden="true" />
            : <PanelRightOpenIcon aria-hidden="true" />}
        </Button>
        {expanded ? (
          <div className="min-w-0">
            <div className="text-xs text-muted-foreground">{messages.rightSidebar}</div>
            <h2 className="truncate text-sm font-semibold">{messages.caseContext}</h2>
          </div>
        ) : null}
      </div>
      {!expanded ? null : (
        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto border-t p-4 pt-3">
          <section aria-labelledby={`allergy-warning-heading-${detail.caseId}`} className="border-b pb-4">
            <h3 className="text-sm font-semibold" id={`allergy-warning-heading-${detail.caseId}`}>
              {messages.allergyWarnings}
            </h3>
            {detail.allergies.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">{messages.noAllergyWarnings}</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {detail.allergies.map(allergy => (
                  <Badge key={`${allergy.code}:${allergy.display}`} variant="destructive">
                    {allergy.display}
                  </Badge>
                ))}
              </div>
            )}
          </section>
          <section aria-labelledby={`presentation-summary-heading-${detail.caseId}`} className="border-b pb-4">
            <h3 className="text-sm font-semibold" id={`presentation-summary-heading-${detail.caseId}`}>
              {messages.presentationSummary}
            </h3>
            <dl className="mt-2 flex flex-col gap-2 text-sm">
              <ContextFact label={messages.chiefComplaint} value={detail.presentation.chiefComplaint} />
              <ContextFact label={messages.status} value={statusText} />
              <ContextFact
                label={messages.priorDiseases}
                value={detail.priorFacts.map(fact => fact.display).join('、') || '-'}
              />
            </dl>
          </section>
          <section aria-labelledby={`vital-signs-heading-${detail.caseId}`} className="border-b pb-4">
            <h3 className="text-sm font-semibold" id={`vital-signs-heading-${detail.caseId}`}>
              {labels.vitalSigns}
            </h3>
            <p className="mt-2 text-sm font-medium tabular-nums">
              T {vitalSigns.temperatureC} °C · P {vitalSigns.pulseBpm} · R {vitalSigns.respirationBpm}
              {' · '}BP {vitalSigns.bloodPressure.systolicMmHg}/{vitalSigns.bloodPressure.diastolicMmHg}
              {' · '}SpO₂ {vitalSigns.oxygenSaturationPct}%
            </p>
          </section>
          {completion === undefined ? null : (
            <section aria-labelledby={`completion-heading-${detail.caseId}`} className="border-b pb-4">
              <h3 className="text-sm font-semibold" id={`completion-heading-${detail.caseId}`}>
                {messages.encounterCompletionChecklist}
              </h3>
              <p className="mt-2 text-xs text-muted-foreground">
                {messages.encounterCompletionSatisfied
                  .replace('{complete}', String(completionCount))
                  .replace('{total}', String(completion.items.length))}
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {completion.items.map(item => (
                  <li className="flex items-center justify-between gap-2 text-xs" key={item.code}>
                    <span>{item.statusText}</span>
                    <Badge variant={item.status === 'complete' ? 'success' : 'secondary'}>
                      {item.status === 'complete' ? labels.complete : labels.incomplete}
                    </Badge>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <PageContext detail={detail} locale={locale} messages={messages} section={section} />
        </div>
      )}
    </aside>
  )
}
