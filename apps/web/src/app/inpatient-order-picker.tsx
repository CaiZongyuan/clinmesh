import { inpatientCatalogSearchSchema, type inpatientMedicationSchema, type inpatientServiceSchema } from '@clinmesh/contracts/inpatient-clinical'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { z } from 'zod'
import { Button } from '@clinmesh/ui/components/button'
import { Input } from '@clinmesh/ui/components/input'
import { useQuery } from '@tanstack/react-query'
import { SearchIcon } from 'lucide-react'
import { useState } from 'react'
import { apiGet } from './api-client.ts'
import { missingFieldLabel } from './inpatient-catalog-picker.tsx'
import { OrderCatalogCandidate } from './doctor/order-composer-layout.tsx'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { formatFen } from './workspace-format.ts'
import { inpatientFrequencyLabel } from './inpatient-labels.ts'

export type InpatientOrderPick =
  | { kind: 'medication'; item: z.infer<typeof inpatientMedicationSchema> }
  | { kind: 'service'; item: z.infer<typeof inpatientServiceSchema> }

/** 医嘱项目搜索框：药品按院内目录服务端检索（含暂不能开立项及原因），护理与治疗项目取住院目录。建议列表只在输入或查询后出现。 */
export function InpatientOrderPicker({ id, session, locale, services, diagnosed, disabled, picked, onPick }: {
  id: string; session: SessionContext; locale: WorkspaceLocale; services: Array<z.infer<typeof inpatientServiceSchema>>
  diagnosed: boolean; disabled: boolean; picked: InpatientOrderPick | null; onPick(pick: InpatientOrderPick | null): void
}): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const [text, setText] = useState(''), [open, setOpen] = useState(false), [showUnavailable, setShowUnavailable] = useState(false)
  const query = text.trim(), visible = open && picked === null
  const medications = useQuery({ queryKey: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId, 'catalog-search', 'medication', 'hospital', query, 1],
    enabled: visible, queryFn: ({ signal }) => apiGet(`/api/his/v1/inpatient/catalog-search?${new URLSearchParams({ kind: 'medication', source: 'hospital', query, page: '1', pageSize: '50' })}`, inpatientCatalogSearchSchema, signal) })
  const available = medications.data?.items.flatMap(item => item.status === 'available' && item.medication ? [item.medication] : []) ?? []
  const unavailable = medications.data?.items.filter(item => item.status !== 'available') ?? []
  const matchedServices = services.filter(item => item.display.toLowerCase().includes(query.toLowerCase()))
  const pick = (next: InpatientOrderPick) => { onPick(next); setText(''); setOpen(false); setShowUnavailable(false) }
  return <div className="relative flex min-w-0 flex-col gap-2">
    <div className="flex gap-2">
      <div className="relative min-w-0 flex-1">
        <SearchIcon aria-hidden="true" className="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input id={id} className="ps-8" maxLength={200} disabled={disabled} autoComplete="off" placeholder={t('搜索药品、护理或治疗项目', 'Search medications, nursing or treatment items')}
          aria-expanded={visible} aria-controls={`${id}-suggestions`} value={picked ? picked.item.display : text}
          onChange={event => { if (picked) onPick(null); setText(event.currentTarget.value); setOpen(event.currentTarget.value.trim().length > 0) }}
          onKeyDown={event => { if (event.key === 'Escape' && visible) { event.preventDefault(); setOpen(false) } }} />
      </div>
      <Button type="button" variant="outline" disabled={disabled} aria-controls={`${id}-suggestions`} onClick={() => { if (picked) { onPick(null); setText('') } setOpen(true) }}><SearchIcon data-icon="inline-start" />{t('查询', 'Search')}</Button>
    </div>
    {visible ? <section id={`${id}-suggestions`} aria-label={t('医嘱项目候选', 'Order item suggestions')}
      className="absolute inset-x-0 top-full z-20 mt-1 flex max-h-80 flex-col overflow-y-auto rounded-md border bg-popover text-popover-foreground shadow-md">
      {medications.isPending ? <p role="status" className="p-3 text-sm text-muted-foreground">{t('正在查询目录', 'Loading catalog')}</p> : null}
      {medications.error ? <div role="alert" className="flex flex-wrap items-center gap-2 p-3 text-sm text-destructive">{t('药品目录查询失败：', 'Medication search failed: ')}{getWorkspaceErrorMessage(medications.error, getWorkspaceMessages(locale))}
        <Button type="button" size="sm" variant="outline" onClick={() => void medications.refetch()}>{t('重试目录查询', 'Retry catalog query')}</Button></div> : null}
      <ul className="divide-y">
        {available.map(item => <li key={item.id}><OrderCatalogCandidate disabled={!diagnosed} onSelect={() => pick({ kind: 'medication', item })}>
          <strong>{item.display}</strong><span className="text-xs text-muted-foreground">{t('药品', 'Medication')}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{[item.doses[0] ? `${t('每次 ', 'Per dose ')}${item.doses[0].doseText}` : undefined, item.frequencyCodes[0] ? inpatientFrequencyLabel(item.frequencyCodes[0], locale, false) : undefined, `${formatFen(item.priceFen, locale)}/${item.unit}`].filter(Boolean).join(' · ')}</span>
          {diagnosed ? null : <span className="ms-auto text-xs text-warning">{t('先确认诊断', 'Confirm diagnosis first')}</span>}
        </OrderCatalogCandidate></li>)}
        {matchedServices.map(item => <li key={item.id}><OrderCatalogCandidate onSelect={() => pick({ kind: 'service', item })}>
          <strong>{item.display}</strong><span className="text-xs text-muted-foreground">{t('护理', 'Nursing')}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{formatFen(item.priceFen, locale)}/{item.unit}</span>
        </OrderCatalogCandidate></li>)}
        {showUnavailable ? unavailable.map(item => <li key={item.id} className="flex flex-wrap items-baseline gap-x-2 px-3 py-1.5 ps-9 text-sm text-muted-foreground">
          <span>{item.display}</span><span className="text-xs">{t('暂不能开立：', 'Unavailable: ')}{item.status === 'inactive' ? t('已停用', 'Inactive') : item.missingFields.map(field => missingFieldLabel(field, zh, 'medication')).join(zh ? '、' : ', ')}</span>
        </li>) : null}
      </ul>
      {!showUnavailable && unavailable.length > 0 ? <Button type="button" variant="ghost" size="sm" className="justify-start rounded-none text-muted-foreground" onClick={() => setShowUnavailable(true)}>
        {t(`另有 ${unavailable.length} 项暂不能开立 · 查看原因`, `${unavailable.length} more unavailable · View reasons`)}</Button> : null}
      {medications.data && available.length + matchedServices.length + unavailable.length === 0 ? <p className="p-3 text-sm text-muted-foreground">{t('没有匹配的项目。', 'No matching items.')}</p> : null}
    </section> : null}
  </div>
}
