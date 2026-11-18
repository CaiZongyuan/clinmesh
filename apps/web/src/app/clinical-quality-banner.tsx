import {
  clinicalOverrideInputSchema,
  clinicalOverrideReasonSchema,
  type ClinicalOverrideInput,
  type ClinicalOverrideReason,
  type ClinicalQualityAlert,
  type ClinicalQualityCheck,
  type ClinicalQualityRedLine,
} from '@clinmesh/contracts/clinical-quality'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { CircleAlertIcon } from 'lucide-react'
import { useId, useState } from 'react'
import { ApiClientError } from './api-client.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

const reasonCopy: Record<ClinicalOverrideReason, readonly [string, string]> = {
  'documented-contraindication': ['存在明确禁忌或高出血/不良反应风险', 'Documented contraindication or bleeding/adverse risk'],
  'external-result-verified': ['已核对外院或床旁近期检查结果', 'Verified recent external or bedside result'],
  'result-pending-follow-up': ['已同步开立检查并安排复诊随访', 'Ordered workup with scheduled follow-up'],
  'patient-informed-refusal': ['患者或家属知情拒绝相关检查/用药', 'Informed refusal by patient or family'],
  'clinical-judgement': ['经专科综合评估符合个体化诊疗方案', 'Individualized specialist clinical judgement'],
  'emergency-care': ['急危重症优先处置', 'Urgent or emergency care priority'],
}

export function extractClinicalQualityError(err: unknown) {
  if (!(err instanceof ApiClientError) || !err.clinicalQuality) return undefined
  return {
    check: err.clinicalQuality,
    code: err.clinicalQuality.redLines.length > 0 || err.code === 'CLINICAL_QUALITY_RED_LINE'
      ? 'CLINICAL_QUALITY_RED_LINE' as const
      : 'CLINICAL_QUALITY_ALERT' as const,
    message: err.message,
  }
}

export function QualityFindingList({ items, destructive }: { items: readonly (ClinicalQualityAlert | ClinicalQualityRedLine)[]; destructive?: boolean }) {
  return <ul className="flex min-w-0 flex-col gap-1">{items.map((it, i) => (
    <li key={`${it.code}-${it.catalogItemId ?? i}`} className="flex flex-wrap items-baseline gap-1.5 text-sm">
      <Badge variant={destructive ? 'destructive' : 'outline'}>{it.code}</Badge>
      <span>{it.message}</span>
      {it.evidence.length > 0 ? <span className="text-xs text-muted-foreground">（{it.evidence.map(e => `${e.label} ${e.reference}`).join('；')}）</span> : null}
    </li>
  ))}</ul>
}

export function ClinicalOverrideFields({ disabled = false, id, locale, note, setNote, reason, setReason }: {
  disabled?: boolean | undefined
  id: string
  locale: WorkspaceLocale
  note: string
  setNote: (v: string) => void
  reason: ClinicalOverrideReason | null
  setReason: (v: ClinicalOverrideReason | null) => void
}) {
  const zh = locale === 'zh-CN'
  return <div className="grid min-w-0 gap-2 sm:grid-cols-2">
    <Field>
      <FieldLabel htmlFor={`${id}-r`}>{zh ? '受控越权原因' : 'Override reason'}</FieldLabel>
      <WorkspaceSelect disabled={disabled} id={`${id}-r`} items={clinicalOverrideReasonSchema.options.map(v => ({ value: v, label: reasonCopy[v][zh ? 0 : 1] }))}
        onValueChange={setReason} placeholder={zh ? '请选择临床原因' : 'Choose clinical reason'} value={reason} wrapLabels />
    </Field>
    <Field>
      <FieldLabel htmlFor={`${id}-n`}>{zh ? '医学说明（至少 4 字）' : 'Clinical note (min 4 chars)'}</FieldLabel>
      <Input disabled={disabled} id={`${id}-n`} maxLength={500} onChange={e => setNote(e.currentTarget.value)}
        placeholder={zh ? '填写具体禁忌、外院依据或随访安排' : 'Contraindication, external result or follow-up'} value={note} />
    </Field>
  </div>
}

export function ClinicalQualityBanner({ check, code, error, initialOverride, locale, onSubmitOverride, pending = false, submitLabel }: {
  check?: ClinicalQualityCheck | undefined
  code?: string | undefined
  error?: unknown
  initialOverride?: ClinicalOverrideInput | undefined
  locale: WorkspaceLocale
  onSubmitOverride?: ((override: ClinicalOverrideInput) => void) | undefined
  pending?: boolean | undefined
  submitLabel?: string | undefined
}): React.JSX.Element | null {
  const res = extractClinicalQualityError(error) ?? (check ? { check, code: check.redLines.length > 0 || code === 'CLINICAL_QUALITY_RED_LINE' ? 'CLINICAL_QUALITY_RED_LINE' as const : 'CLINICAL_QUALITY_ALERT' as const } : undefined)
  const id = useId()
  const [reason, setReason] = useState<ClinicalOverrideReason | null>(initialOverride?.reasonCode ?? null)
  const [note, setNote] = useState(initialOverride?.note ?? '')
  if (!res) return null
  const zh = locale === 'zh-CN', c = res.check
  if (res.code === 'CLINICAL_QUALITY_RED_LINE' || c.redLines.length > 0) {
    return <Alert aria-label={zh ? '药事安全红线拦截' : 'Medication safety red-line block'} variant="destructive">
      <CircleAlertIcon aria-hidden="true" />
      <AlertTitle>{zh ? '药事安全红线拦截（不可越权）' : 'Medication safety red-line block (non-overridable)'}</AlertTitle>
      <AlertDescription className="flex min-w-0 flex-col gap-1.5">
        <QualityFindingList items={c.redLines} destructive />
        <p className="text-xs font-medium">{zh ? '请修改或移除违规项目后再提交；安全红线不支持填写说明放行。' : 'Adjust or remove the blocked item before submitting; safety red lines cannot be overridden.'}</p>
      </AlertDescription>
    </Alert>
  }
  if (c.alerts.length === 0) return null
  const parsed = clinicalOverrideInputSchema.safeParse({ acknowledgedAlerts: [...new Set(c.alerts.map(a => a.code))], note, reasonCode: reason })
  return <section aria-label={zh ? '临床质控警示' : 'Clinical quality alert'} className="flex min-w-0 flex-col gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm" data-clinical-quality-alert="" role="region">
    <div className="flex flex-wrap items-center gap-2">
      <CircleAlertIcon aria-hidden="true" className="size-4 shrink-0 text-warning" />
      <strong className="font-semibold">{zh ? '临床质控警示（需补齐依据或登记原因）' : 'Clinical quality alert (complete workup/orders or record override)'}</strong>
    </div>
    <QualityFindingList items={c.alerts} />
    {onSubmitOverride ? <div className="flex min-w-0 flex-col gap-2">
      <ClinicalOverrideFields disabled={pending} id={id} locale={locale} note={note} reason={reason} setNote={setNote} setReason={setReason} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{zh ? '登记的原因与医学说明将记入正式审计留痕。' : 'Reason and clinical note are recorded in the audit trail.'}</span>
        <Button disabled={pending || !parsed.success} onClick={() => { if (parsed.success) onSubmitOverride(parsed.data) }} size="sm" type="button">
          {submitLabel ?? (zh ? '登记说明并重新提交' : 'Record override and resubmit')}
        </Button>
      </div>
    </div> : null}
  </section>
}

export function InpatientClinicalQualityBanner({ admissionId, locale, match = true, onSubmitOverride, operation, pending, write }: {
  admissionId: string
  locale: WorkspaceLocale
  match?: boolean | undefined
  onSubmitOverride: (override: ClinicalOverrideInput) => void
  operation: string
  pending?: boolean | undefined
  write: { mutation: { error: unknown; variables?: { operation: string; input: object } | undefined } }
}) {
  const v = write.mutation.variables
  return !match || v?.operation !== operation || !('admissionId' in v.input) || v.input.admissionId !== admissionId ? null
    : <ClinicalQualityBanner error={write.mutation.error} locale={locale} onSubmitOverride={onSubmitOverride} pending={pending} />
}
