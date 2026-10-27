import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientPciSelectionSchema, inpatientPciSelectionParametersSchema, type InpatientPciSelection, type InpatientPciSelectionParameters } from '@clinmesh/contracts/inpatient-pci-selection'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { apiGet } from './api-client.ts'
import { WorkspaceSelect } from './workspace-select.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'

type Props = { admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; write: ReturnType<typeof useInpatientWriteIntent> }
const measurementLabels = [ ['lesion-length', '病变长度', 'Lesion length'], ['proximal-reference-diameter', '近端参考直径', 'Proximal reference diameter'], ['distal-reference-diameter', '远端参考直径', 'Distal reference diameter'] ] as const
const categoryLabels = { guidewire: ['导丝', 'Guidewire'], 'guiding-catheter': ['导引导管', 'Guiding catheter'], balloon: ['球囊', 'Balloon'], stent: ['支架', 'Stent'] } as const

export function InpatientPciSelection(props: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return <details onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{props.locale === 'zh-CN' ? 'PCI 选型参数与候选依据' : 'PCI parameters and candidate evidence'}</summary>
    {expanded ? <SelectionContent {...props} /> : null}
  </details>
}
function SelectionContent(props: Props) {
  const { admission, session, locale } = props
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const query = useQuery({ queryKey: [...inpatientScopeKey(session), admission.id, 'pci-selection'],
    queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/admissions/${admission.id}/pci-selection`, inpatientPciSelectionSchema, signal) })
  return <section aria-label={t('PCI 参数与候选', 'PCI parameters and candidates')} className="flex flex-col gap-3 py-3">
    {query.isPending ? <p>{t('正在加载 PCI 参数', 'Loading PCI parameters')}</p> : null}
    {query.error ? <Alert variant="destructive"><AlertDescription>{getWorkspaceErrorMessage(query.error, getWorkspaceMessages(locale))}</AlertDescription></Alert> : null}
    {query.data ? <>
      <p>{query.data.evidencePackage.limitation}</p>
      <p>{t('依据版本：', 'Evidence version: ')}{query.data.evidencePackage.id} · {query.data.evidencePackage.version}</p>
      <p>{query.data.confirmation ? t(`已确认参数 v${query.data.confirmation.version} · ${query.data.confirmation.confirmedBy} · ${query.data.confirmation.confirmedAt}`, `Confirmed v${query.data.confirmation.version} · ${query.data.confirmation.confirmedBy} · ${query.data.confirmation.confirmedAt}`) : t('尚未确认参数；未知测量保留未知，不从耗材规格反推。', 'No confirmed parameters. Unknown measurements stay unknown.')}</p>
      {session.actor.roleCode === 'inpatient-doctor' && admission.status === 'admitted' && admission.recordStatus !== 'archived' ? <SelectionEditor key={`${query.data.confirmation?.version ?? 0}`} {...props} selection={query.data} /> : null}
      {query.data.candidates.map(candidate => <article key={candidate.materialId} className="flex flex-col gap-1 rounded-md border p-3">
        <p>{candidate.item?.display ?? candidate.evidence.specification} · {candidate.materialId} v{candidate.materialVersion}</p>
        <p>{t('候选状态：', 'Candidate status: ')}{{ valid: t('可用于仿真建议', 'Eligible for simulation'), incomplete: t('依据不完整', 'Incomplete'), inapplicable: t('超出仿真适用范围', 'Outside simulation scope'), unavailable: t('本院版本不可用', 'Hospital version unavailable') }[candidate.eligibility]}</p>
        {candidate.missing.map(reason => <p key={reason}>{reason}</p>)}
        <p>{candidate.item ? `${formatFen(candidate.item.chargeDefinition.priceFen, locale)}/${candidate.item.chargeDefinition.unit}` : t('无可用院内收费价', 'No available hospital price')} · {t('预计数量：', 'Planned quantity: ')}{candidate.expectedQuantity ?? t('未知', 'Unknown')} · {t('预计收费：', 'Estimated charge: ')}{candidate.expectedAmountFen === null ? t('未知', 'Unknown') : formatFen(candidate.expectedAmountFen, locale)}</p>
        <details><summary>{t('查看合成适用、兼容与数量依据', 'Review synthetic applicability, compatibility and quantity evidence')}</summary>
          <p>{candidate.evidence.scope}</p><p>{candidate.evidence.applicability}</p><p>{candidate.evidence.compatibility}</p><p>{candidate.evidence.quantityBasis}</p><p>{candidate.evidence.id} · {candidate.evidence.version} · {candidate.evidence.sourceLocator}</p>
          {candidate.item?.reference ? <p>{t('原价格来源（不证明临床适用）：', 'Original price source (does not establish clinical applicability): ')}{candidate.item.reference.sourceId} · {candidate.item.reference.sourceLocator} · {candidate.item.reference.enterprise} · {candidate.item.reference.registrationNumber ?? t('注册证未知', 'Unknown registration')} · {candidate.item.reference.specification ?? t('原规格未知', 'Unknown source specification')} · {candidate.item.reference.unit ?? t('原单位未知', 'Unknown source unit')} · {candidate.item.reference.applicability}</p> : null}
        </details>
      </article>)}
      <details><summary>{t('查看参数确认历史', 'Review parameter history')}</summary>{query.data.history.map(item => <article key={item.version}><p>v{item.version} · {item.confirmedAt} · {item.confirmedBy} · {item.parameters.treatmentPlan}</p>{item.parameters.measurements.map(measurement => <p key={measurement.kind}>{measurement.kind} · {measurement.object} · {measurement.site} · {measurement.value ?? t('未知', 'Unknown')} {measurement.unit ?? t('单位未知', 'Unknown unit')} · {measurement.method} · {measurement.source.reference} v{measurement.source.version} · {measurement.source.note}</p>)}</article>)}</details>
    </> : null}
  </section>
}
function SelectionEditor({ admission, locale, write, selection }: Props & { selection: InpatientPciSelection }) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const [draft, setDraft] = useState<InpatientPciSelectionParameters>(() => selection.confirmation?.parameters ?? { treatmentPlan: '', targetSite: '', measurements: [], plannedQuantities: [], approvedMaterialIds: [] })
  const [invalid, setInvalid] = useState(false)
  const blocked = write.blocked
  return <form onSubmit={event => {
    event.preventDefault()
    const parsed = inpatientPciSelectionParametersSchema.safeParse(draft)
    setInvalid(!parsed.success)
    if (parsed.success) write.mutation.mutate({ operation: 'inpatient.pci-selection.confirm', input: { admissionId: admission.id, expectedVersion: selection.confirmation?.version ?? 0, parameters: parsed.data } })
  }}><FieldSet disabled={blocked}><FieldLegend>{t('医生手工确认 PCI 参数', 'Doctor confirmation of PCI parameters')}</FieldLegend><FieldGroup>
    <Field data-invalid={invalid && !draft.treatmentPlan.trim()}><FieldLabel htmlFor="pci-treatment">{t('治疗方向与术式', 'Treatment direction and procedure')}</FieldLabel><Input id="pci-treatment" aria-invalid={invalid && !draft.treatmentPlan.trim()} required maxLength={2000} value={draft.treatmentPlan} onChange={event => setDraft({ ...draft, treatmentPlan: event.currentTarget.value })} /></Field>
    <Field data-invalid={invalid && !draft.targetSite.trim()}><FieldLabel htmlFor="pci-site">{t('靶病变部位', 'Target lesion site')}</FieldLabel><Input id="pci-site" aria-invalid={invalid && !draft.targetSite.trim()} required maxLength={2000} value={draft.targetSite} onChange={event => setDraft({ ...draft, targetSite: event.currentTarget.value })} /></Field>
    {measurementLabels.map(([kind, cn, en]) => {
      const current = draft.measurements.find(item => item.kind === kind) ?? { kind, object: 'unknown' as const, site: '', value: null, unit: null, method: '', source: { reference: '', version: '', note: '', synthetic: true } }
      const update = (patch: Partial<typeof current>) => setDraft({ ...draft, measurements: [...draft.measurements.filter(item => item.kind !== kind), { ...current, ...patch }] })
      const prefix = `pci-${kind}`, label = t(cn, en)
      return <FieldSet key={kind}><FieldLegend>{label}</FieldLegend><FieldGroup className="grid gap-3 md:grid-cols-2">
        <Field><FieldLabel htmlFor={`${prefix}-value`}>{label} {t('数值', 'value')}</FieldLabel><Input id={`${prefix}-value`} type="number" min="0" step="any" value={current.value ?? ''} onChange={event => update({ value: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) })} /></Field>
        <Field><FieldLabel htmlFor={`${prefix}-unit`}>{label} {t('单位', 'unit')}</FieldLabel><Input id={`${prefix}-unit`} value={current.unit ?? ''} onChange={event => update({ unit: event.currentTarget.value || null })} /></Field>
        <Field><FieldLabel htmlFor={`${prefix}-object`}>{label} {t('测量对象', 'measurement object')}</FieldLabel><WorkspaceSelect id={`${prefix}-object`} value={current.object} items={[{ value: 'unknown', label: t('未知', 'Unknown') }, { value: 'lesion', label: t('病变', 'Lesion') }, { value: 'reference-lumen', label: t('参考管腔', 'Reference lumen') }, { value: 'external-elastic-membrane', label: t('外弹力膜', 'External elastic membrane') }]} onValueChange={value => { if (value) update({ object: value as typeof current.object }) }} /></Field>
        {(['site', 'method'] as const).map(field => <Field key={field} data-invalid={invalid && !current[field].trim()}><FieldLabel htmlFor={`${prefix}-${field}`}>{label} {field === 'site' ? t('部位', 'site') : t('方法', 'method')}</FieldLabel><Input id={`${prefix}-${field}`} aria-invalid={invalid && !current[field].trim()} maxLength={2000} value={current[field]} onChange={event => update({ [field]: event.currentTarget.value })} /></Field>)}
        {(['reference', 'version', 'note'] as const).map(field => <Field key={field} data-invalid={invalid && !current.source[field].trim()}><FieldLabel htmlFor={`${prefix}-${field}`}>{label} {{ reference: t('来源标识', 'source reference'), version: t('来源版本', 'source version'), note: t('来源说明', 'source note') }[field]}</FieldLabel><Input id={`${prefix}-${field}`} aria-invalid={invalid && !current.source[field].trim()} maxLength={2000} value={current.source[field]} onChange={event => update({ source: { ...current.source, [field]: event.currentTarget.value } })} /></Field>)}
        <Field orientation="horizontal"><Checkbox id={`${prefix}-synthetic`} checked={current.source.synthetic} onCheckedChange={checked => update({ source: { ...current.source, synthetic: !!checked } })} /><FieldLabel htmlFor={`${prefix}-synthetic`}>{label} {t('来源为合成数据', 'source is synthetic')}</FieldLabel></Field>
      </FieldGroup></FieldSet>
    })}
    <FieldSet><FieldLegend>{t('独立数量计划', 'Independent quantity plan')}</FieldLegend><FieldGroup>
      {Object.entries(categoryLabels).map(([category, labels]) => {
        const typedCategory = category as keyof typeof categoryLabels
        const current = draft.plannedQuantities.find(item => item.category === category) ?? { category: typedCategory, quantity: null, basis: '' }
        const update = (patch: Partial<typeof current>) => setDraft({ ...draft, plannedQuantities: [...draft.plannedQuantities.filter(item => item.category !== category), { ...current, ...patch }] })
        const label = t(labels[0], labels[1])
        return <FieldGroup key={category} className="grid gap-3 md:grid-cols-2"><Field><FieldLabel htmlFor={`pci-quantity-${category}`}>{label} {t('预计数量', 'planned quantity')}</FieldLabel><Input id={`pci-quantity-${category}`} type="number" min="1" max="1000" step="1" value={current.quantity ?? ''} onChange={event => update({ quantity: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) })} /></Field><Field><FieldLabel htmlFor={`pci-basis-${category}`}>{label} {t('数量依据', 'quantity basis')}</FieldLabel><Input id={`pci-basis-${category}`} maxLength={2000} value={current.basis} onChange={event => update({ basis: event.currentTarget.value })} /></Field></FieldGroup>
      })}
    </FieldGroup></FieldSet>
    <FieldSet><FieldLegend>{t('医生认可的具体仿真候选', 'Specific simulation candidates accepted by the doctor')}</FieldLegend><FieldGroup>{selection.candidates.map(candidate => <Field key={candidate.materialId} orientation="horizontal"><Checkbox id={`pci-approved-${candidate.materialId}`} disabled={candidate.item === null} checked={draft.approvedMaterialIds.includes(candidate.materialId)} onCheckedChange={checked => setDraft({ ...draft, approvedMaterialIds: checked ? [...draft.approvedMaterialIds, candidate.materialId] : draft.approvedMaterialIds.filter(id => id !== candidate.materialId) })} /><FieldLabel htmlFor={`pci-approved-${candidate.materialId}`}>{candidate.evidence.specification}</FieldLabel></Field>)}</FieldGroup></FieldSet>
    {invalid ? <Alert variant="destructive"><AlertDescription>{t('请核对已录入测量的对象、部位、单位、方法、完整来源和数量依据；尚未取得的整项测量可以留空。', 'Check the measurement object, site, unit, method, full source and quantity basis. Measurements not yet obtained may stay empty.')}</AlertDescription></Alert> : null}
    <Button type="submit" disabled={blocked}>{t('确认 PCI 参数', 'Confirm PCI parameters')}</Button>
  </FieldGroup></FieldSet></form>
}
