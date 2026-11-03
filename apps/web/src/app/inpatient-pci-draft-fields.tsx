import type { z } from 'zod'
import type { inpatientAngiographyReportSchema } from '@clinmesh/contracts/inpatient-angiography'
import type { inpatientPciSelectionDraftSchema } from '@clinmesh/contracts/inpatient-pci-selection'
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { AgentDraftField } from './workspace-card-layout.tsx'
import { WorkspaceSelect } from './workspace-select.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export type PciSelectionDraft = z.infer<typeof inpatientPciSelectionDraftSchema>
const measurementLabels = [['lesion-length', '病变长度', 'Lesion length'], ['proximal-reference-diameter', '近端参考直径', 'Proximal reference diameter'], ['distal-reference-diameter', '远端参考直径', 'Distal reference diameter']] as const
const categoryLabels = { guidewire: ['导丝', 'Guidewire'], 'guiding-catheter': ['导引导管', 'Guiding catheter'], balloon: ['球囊', 'Balloon'], stent: ['支架', 'Stent'] } as const
const objectLabels = { lesion: ['病变', 'Lesion'], 'reference-lumen': ['参考管腔', 'Reference lumen'], 'external-elastic-membrane': ['外弹力膜', 'External elastic membrane'], unknown: ['未知', 'Unknown'] } as const

export function InpatientPciDraftFields({ draft, value, report, locale, disabled, issues, onChange }: {
  draft: PciSelectionDraft; value: PciSelectionDraft['parameters']; report: z.infer<typeof inpatientAngiographyReportSchema> | undefined;
  locale: WorkspaceLocale; disabled: boolean; issues: readonly z.ZodIssue[]; onChange(value: PciSelectionDraft['parameters']): void;
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const prefix = `pci-draft-${draft.requestId}`
  const hasIssue = (path: readonly PropertyKey[]) => issues.some(issue => issue.path.length === path.length && path.every((part, index) => issue.path[index] === part))
  return <section aria-label={t('报告带入的 PCI 参数', 'Report-derived PCI parameters')} className="flex flex-col gap-3">
    <h6 className="font-medium">{t('报告带入的 PCI 参数', 'Report-derived PCI parameters')}</h6>
    <p>{t('绑定造影报告：', 'Linked angiography report: ')}{draft.reportId} v{draft.reportVersion} · {t('待确认选型', 'Unconfirmed selection')} v{draft.version}</p>
    <p>{t('缺少的测量保持未知，不从目录规格倒推。修改后先保存参数，再统一审阅确认。', 'Missing measurements stay unknown and are never inferred from catalog specifications. Save edits before reviewing and confirming together.')}</p>
    <details><summary>{t('依据', 'Evidence')}</summary>
      {report ? <>
        <p>{t('正式合成造影报告：', 'Formal synthetic angiography report: ')}{report.id} v{report.version} · Procedure/{report.procedureId}</p>
        <p>{t('报告靶部位：', 'Reported target site: ')}{report.targetSite ?? t('尚未取得', 'Not available')}</p>
        {report.measurements.map(item => {
          const label = measurementLabels.find(([kind]) => kind === item.kind)!, object = objectLabels[item.object]
          return <p key={item.kind}>{t(label[1], label[2])} · {item.value ?? t('未知', 'Unknown')} {item.unit ?? t('单位未知', 'Unknown unit')} · {item.site} · {t(object[0], object[1])} · {item.method} · {item.source.reference} v{item.source.version}</p>
        })}
        {report.missing.map(reason => <p key={reason}>{reason}</p>)}
      </> : <p>{t('报告原件尚未读取，当前仅显示选型参数关联的报告信息。', 'The original report is not loaded; only the report linked to these selection parameters is shown.')}</p>}
    </details>
    <FieldSet disabled={disabled}><FieldGroup>
      {(['treatmentPlan', 'targetSite'] as const).map(field => {
        const invalid = hasIssue([field]), id = `${prefix}-${field}`
        return <AgentDraftField key={field} locale={locale} assisted={!draft.edited && value[field] !== null && value[field] !== '' && value[field] === draft.parameters[field]}>
          <Field data-invalid={invalid || undefined}><FieldLabel htmlFor={id}>{field === 'treatmentPlan' ? t('治疗方向与术式', 'Treatment direction and procedure') : t('靶病变部位', 'Target lesion site')}</FieldLabel>
            <Input id={id} maxLength={2000} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined} value={value[field] ?? ''} onChange={event => onChange({ ...value, [field]: field === 'targetSite' ? event.currentTarget.value || null : event.currentTarget.value })} />
            {invalid ? <FieldError id={`${id}-error`}>{field === 'treatmentPlan' ? t('请填写治疗方向与术式，最多 2000 字。', 'Enter the treatment direction and procedure (up to 2,000 characters).')
              : t('请填写不超过 2000 字的靶病变部位，未知可留空。', 'Enter the target lesion site (up to 2,000 characters), or leave it empty if unknown.')}</FieldError> : null}</Field>
          {value[field] !== draft.parameters[field] ? <p className="text-sm text-muted-foreground">{t('最新已保存：', 'Latest saved: ')}{draft.parameters[field] ?? t('尚未取得', 'Not available')}</p> : null}
        </AgentDraftField>
      })}
      {measurementLabels.map(([kind, cn, en]) => {
        const baseline = draft.parameters.measurements.find(item => item.kind === kind)
        const index = value.measurements.findIndex(item => item.kind === kind)
        const current = value.measurements[index] ?? { kind, object: 'unknown' as const, site: '', value: null, unit: null, method: '',
          source: { reference: `InpatientPciSelectionDraft/${draft.requestId}`, version: String(draft.version), note: '医生人工修订', synthetic: true } }
        const assisted = baseline !== undefined && baseline.source.reference === `DiagnosticReport/${draft.reportId}` && baseline.source.version === String(draft.reportVersion)
          && JSON.stringify({ ...current, source: null }) === JSON.stringify({ ...baseline, source: null })
        const update = (patch: Partial<typeof current>) => onChange({ ...value, measurements: [...value.measurements.filter(item => item.kind !== kind), { ...current, ...patch }] })
        const label = t(cn, en), id = `${prefix}-${kind}`
        const invalidValue = hasIssue(['measurements', index, 'value'])
        const invalidUnit = hasIssue(['measurements', index, 'unit'])
        return <AgentDraftField key={kind} locale={locale} assisted={assisted}><FieldSet><FieldLegend>{label}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
          <Field data-invalid={invalidValue || undefined}><FieldLabel htmlFor={`${id}-value`}>{label} {t('数值', 'value')}</FieldLabel><Input id={`${id}-value`} type="number" step="any" aria-invalid={invalidValue || undefined} aria-describedby={invalidValue ? `${id}-value-error` : undefined} value={current.value ?? ''} onChange={event => update({ value: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) })} />
            {invalidValue ? <FieldError id={`${id}-value-error`}>{t('请输入大于 0 且不超过 1000 的有限数值，未知可留空。', 'Enter a finite number greater than 0 and no more than 1,000, or leave it empty if unknown.')}</FieldError> : null}</Field>
          <Field data-invalid={invalidUnit || undefined}><FieldLabel htmlFor={`${id}-unit`}>{label} {t('单位', 'unit')}</FieldLabel><Input id={`${id}-unit`} value={current.unit ?? ''} maxLength={2000} aria-invalid={invalidUnit || undefined} aria-describedby={invalidUnit ? `${id}-unit-error` : undefined} onChange={event => update({ unit: event.currentTarget.value || null })} />
            {invalidUnit ? <FieldError id={`${id}-unit-error`}>{t('请填写不超过 2000 字的测量单位，未知可留空。', 'Enter the measurement unit (up to 2,000 characters), or leave it empty if unknown.')}</FieldError> : null}</Field>
          <Field><FieldLabel htmlFor={`${id}-object`}>{label} {t('测量对象', 'measurement object')}</FieldLabel><WorkspaceSelect id={`${id}-object`} value={current.object} items={[
            { value: 'unknown', label: t('未知', 'Unknown') }, { value: 'lesion', label: t('病变', 'Lesion') }, { value: 'reference-lumen', label: t('参考管腔', 'Reference lumen') }, { value: 'external-elastic-membrane', label: t('外弹力膜', 'External elastic membrane') },
          ]} onValueChange={object => { if (object) update({ object: object as typeof current.object }) }} /></Field>
          {(['site', 'method'] as const).map(field => {
            const invalid = hasIssue(['measurements', index, field]), fieldId = `${id}-${field}`
            return <Field key={field} data-invalid={invalid || undefined}><FieldLabel htmlFor={fieldId}>{label} {field === 'site' ? t('部位', 'site') : t('方法', 'method')}</FieldLabel><Input id={fieldId} maxLength={2000} aria-invalid={invalid || undefined} aria-describedby={invalid ? `${fieldId}-error` : undefined} value={current[field]} onChange={event => update({ [field]: event.currentTarget.value })} />
              {invalid ? <FieldError id={`${fieldId}-error`}>{field === 'site' ? t('请填写测量部位，最多 2000 字。', 'Enter the measurement site (up to 2,000 characters).')
                : t('请填写测量方法，最多 2000 字。', 'Enter the measurement method (up to 2,000 characters).')}</FieldError> : null}</Field>
          })}
          {baseline && JSON.stringify(current) !== JSON.stringify(baseline) ? <p className="md:col-span-2 text-sm text-muted-foreground">{t('最新已保存：', 'Latest saved: ')}{baseline.value ?? t('未知', 'Unknown')} {baseline.unit ?? t('单位未知', 'Unknown unit')} · {baseline.site} · {t(objectLabels[baseline.object][0], objectLabels[baseline.object][1])} · {baseline.method} · {baseline.source.reference} v{baseline.source.version} · {baseline.source.note}</p> : null}
          <p className="md:col-span-2">{assisted ? `${t('报告带入：', 'From report: ')}${current.source.reference} v${current.source.version} · ${current.source.note}` : baseline || value.measurements.some(item => item.kind === kind) ? t('医生人工修订；绑定报告仅作为原始依据，不代表报告原值。', 'Doctor edit; the linked report is original evidence and does not contain this edited value.') : t('尚未取得本项测量。', 'This measurement is not available.')}</p>
        </FieldGroup></FieldSet></AgentDraftField>
      })}
      <FieldSet><FieldLegend>{t('独立数量计划', 'Independent quantity plan')}</FieldLegend><FieldGroup>
        {Object.entries(categoryLabels).map(([category, labels]) => {
          const index = value.plannedQuantities.findIndex(item => item.category === category)
          const current = value.plannedQuantities[index] ?? { category: category as keyof typeof categoryLabels, quantity: null, basis: '' }
          const baseline = draft.parameters.plannedQuantities.find(item => item.category === category)
          const update = (patch: Partial<typeof current>) => onChange({ ...value, plannedQuantities: [...value.plannedQuantities.filter(item => item.category !== category), { ...current, ...patch }] })
          const label = t(labels[0], labels[1])
          const invalidQuantity = hasIssue(['plannedQuantities', index, 'quantity']), quantityId = `${prefix}-quantity-${category}`
          const invalidBasis = hasIssue(['plannedQuantities', index, 'basis']), basisId = `${prefix}-basis-${category}`
          return <AgentDraftField key={category} locale={locale} assisted={!draft.edited && baseline !== undefined && JSON.stringify(current) === JSON.stringify(baseline)}><FieldGroup className="grid gap-3 md:grid-cols-2">
            <Field data-invalid={invalidQuantity || undefined}><FieldLabel htmlFor={quantityId}>{label} {t('预计数量', 'planned quantity')}</FieldLabel><Input id={quantityId} type="number" min="1" max="1000" step="1" aria-invalid={invalidQuantity || undefined} aria-describedby={invalidQuantity ? `${quantityId}-error` : undefined} value={current.quantity ?? ''} onChange={event => update({ quantity: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) })} />
              {invalidQuantity ? <FieldError id={`${quantityId}-error`}>{t('请输入 1 至 1000 的整数，未知可留空。', 'Enter a whole number from 1 to 1,000, or leave it empty if unknown.')}</FieldError> : null}</Field>
            <Field data-invalid={invalidBasis || undefined}><FieldLabel htmlFor={basisId}>{label} {t('数量依据', 'quantity basis')}</FieldLabel><Input id={basisId} maxLength={2000} aria-invalid={invalidBasis || undefined} aria-describedby={invalidBasis ? `${basisId}-error` : undefined} value={current.basis} onChange={event => update({ basis: event.currentTarget.value })} />
              {invalidBasis ? <FieldError id={`${basisId}-error`}>{t('请填写数量依据，最多 2000 字。', 'Enter the quantity basis (up to 2,000 characters).')}</FieldError> : null}</Field>
          </FieldGroup>{baseline && JSON.stringify(current) !== JSON.stringify(baseline) ? <p className="text-sm text-muted-foreground">{t('最新已保存：', 'Latest saved: ')}{baseline.quantity ?? t('未知', 'Unknown')} · {baseline.basis}</p> : null}</AgentDraftField>
        })}
      </FieldGroup></FieldSet>
    </FieldGroup></FieldSet>
  </section>
}
