import type { z } from 'zod'
import { useState } from 'react'
import type { inpatientInvestigationCatalogSchema } from '@clinmesh/contracts/inpatient-investigations'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { OrderCatalogCandidate, OrderComposerFooter, OrderComposerLayout, OrderComposerSearch } from './doctor/order-composer-layout.tsx'
import { InvestigationServiceDetails } from './doctor/investigation-service-details.tsx'
import { indicationLabel } from './doctor/laboratory-page.tsx'
import { WorkspaceSelect } from './workspace-select.tsx'
import { formatFen } from './workspace-format.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

type CatalogItem = z.infer<typeof inpatientInvestigationCatalogSchema>['items'][number]
export type InpatientInvestigationSelection = { kind: 'laboratory'; indicationCode: string } | { kind: 'imaging'; indication: string }

/** 门诊开具窗口的住院版：同一目录含检验与检查，确认即开立，不经门诊准备清单。 */
export function InpatientInvestigationComposer({ open, onOpenChange, items, locale, disabled, error, onIssue }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  items: readonly CatalogItem[]
  locale: WorkspaceLocale
  disabled: boolean
  /** 开立失败时显示在窗口内，避免被遮罩挡住工作区提示。 */
  error?: string | undefined
  onIssue: (item: CatalogItem, selection: InpatientInvestigationSelection, done: () => void) => void
}) {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en, messages = getWorkspaceMessages(locale)
  const [query, setQuery] = useState(''), [selectedId, setSelectedId] = useState<string | null>(null)
  const [indicationCode, setIndicationCode] = useState(''), [indication, setIndication] = useState(''), [showUnavailable, setShowUnavailable] = useState(false)
  const reset = () => { setQuery(''); setSelectedId(null); setIndicationCode(''); setIndication(''); setShowUnavailable(false) }
  const change = (next: boolean) => { if (!next) reset(); onOpenChange(next) }
  const text = query.trim().toLowerCase(), matches = (item: CatalogItem) => text === '' || item.display.toLowerCase().includes(text) || item.id.toLowerCase().includes(text)
  const available = items.filter(item => item.available && matches(item)), unavailable = items.filter(item => !item.available && matches(item))
  const selected = items.find(item => item.id === selectedId && item.available)
  const kindLabel = (item: CatalogItem) => item.kind === 'imaging' ? t('检查', 'Imaging') : t('检验', 'Laboratory')
  const unavailableLabel = (item: CatalogItem) => item.unavailableReason === 'unpriced' ? t('未声明住院价格', 'No inpatient price') : t('本院尚未开展', 'Not offered')
  const select = (item: CatalogItem) => { setSelectedId(item.id); setIndicationCode(item.indicationCodes.length === 1 ? item.indicationCodes[0]! : ''); setIndication('') }
  const missing = selected === undefined ? t('请先从左侧选择项目', 'Choose an item first')
    : selected.kind === 'imaging' ? indication.trim().length < 2 ? t('还差：检查指征', 'Enter the clinical indication') : undefined
      : selected.indicationCodes.length === 0 ? t('该项目没有可用的检验适应证', 'No laboratory indication is available') : indicationCode === '' ? t('还差：检验适应证', 'Choose the laboratory indication') : undefined
  const issue = () => {
    if (selected === undefined || missing !== undefined) return
    onIssue(selected, selected.kind === 'imaging' ? { kind: 'imaging', indication: indication.trim() } : { kind: 'laboratory', indicationCode }, () => change(false))
  }
  const candidate = (item: CatalogItem) => <li key={item.id}><OrderCatalogCandidate label={t(`选择${item.display}`, `Select ${item.display}`)} selected={item.id === selectedId} onSelect={() => select(item)}>
    <span className="font-medium">{item.display}</span><span className="text-xs text-muted-foreground">{kindLabel(item)}</span>
    <span className="text-xs tabular-nums text-muted-foreground">{item.priceFen === undefined ? '' : formatFen(item.priceFen, locale)}</span>
  </OrderCatalogCandidate></li>
  return <Dialog open={open} onOpenChange={change}>
    <DialogContent className="flex max-h-[min(720px,calc(100svh-2.5rem))] flex-col sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle>{t('开立住院检查', 'Order inpatient investigation')}</DialogTitle>
        <DialogDescription>{t('在目录中选择项目并确认指征，一次确认一条申请；开立后交病区护士送检。', 'Choose an item and confirm the indication; each confirmation issues one request for the ward nurse to dispatch.')}</DialogDescription>
      </DialogHeader>
      <OrderComposerLayout locale={locale} catalog={<div className="flex min-h-0 flex-1 flex-col">
        <OrderComposerSearch><Input aria-label={t('搜索检查检验目录', 'Search investigations')} placeholder={t('项目名称、部位或方式', 'Name, site or method')} value={query} maxLength={200} onChange={event => setQuery(event.currentTarget.value)} /></OrderComposerSearch>
        <ul data-catalog-results="" className="flex min-h-0 flex-col overflow-y-auto pb-2">
          {available.map(candidate)}
          {available.length === 0 ? <li className="px-4 py-2 text-sm text-muted-foreground">{t('没有匹配的可开立项目', 'No matching orderable items')}</li> : null}
          {unavailable.length > 0 ? <li className="flex flex-wrap items-center gap-x-2 px-4 py-2 text-xs text-muted-foreground">
            {t(`另有 ${unavailable.length} 项暂不能开立`, `${unavailable.length} more items cannot be ordered`)}
            <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" aria-expanded={showUnavailable} onClick={() => setShowUnavailable(value => !value)}>{showUnavailable ? t('收起原因', 'Hide reasons') : t('查看原因', 'View reasons')}</Button>
          </li> : null}
          {showUnavailable ? unavailable.map(item => <li key={item.id} className="flex flex-wrap gap-x-2 px-4 py-1 text-sm text-muted-foreground"><span>{item.display}</span><span className="text-xs">{kindLabel(item)} · {unavailableLabel(item)}</span></li>) : null}
        </ul>
      </div>}>
        {selected === undefined ? null : <div className="flex min-w-0 flex-col gap-3">
          <InvestigationServiceDetails locale={locale} name={selected.display} facts={[{ label: t('类别', 'Category'), value: kindLabel(selected) }]}
            priceFact={{ label: t('住院价格', 'Inpatient price'), value: selected.priceFen === undefined ? '—' : formatFen(selected.priceFen, locale) }} />
          {selected.kind === 'imaging' ? <Field><FieldLabel htmlFor="inpatient-investigation-indication">{t('检查指征', 'Clinical indication')}</FieldLabel>
            <Input id="inpatient-investigation-indication" value={indication} required minLength={2} maxLength={500} placeholder={t('例如：发热咳嗽 3 天，排除肺部感染', 'For example: cough and fever for 3 days')} onChange={event => setIndication(event.currentTarget.value)} /></Field>
            : <Field><FieldLabel htmlFor="inpatient-investigation-lab-indication">{messages.laboratoryIndication}</FieldLabel>
              {selected.indicationCodes.length === 1 ? <div id="inpatient-investigation-lab-indication" className="flex h-8 items-center rounded-md border px-2.5 text-sm">{indicationLabel(selected.indicationCodes[0]!, messages)}</div>
                : <WorkspaceSelect id="inpatient-investigation-lab-indication" value={indicationCode || null} onValueChange={value => setIndicationCode(value ?? '')}
                  items={selected.indicationCodes.map(code => ({ value: code, label: indicationLabel(code, messages) }))} />}</Field>}
        </div>}
      </OrderComposerLayout>
      {error === undefined ? null : <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      <OrderComposerFooter hint={missing ?? t('核对右侧信息后开立', 'Review the details before ordering')}>
        <DialogClose render={<Button type="button" variant="outline" />}>{messages.cancel}</DialogClose>
        <Button type="button" disabled={disabled || missing !== undefined} onClick={issue}>{t('开立住院检查', 'Issue investigation')}</Button>
      </OrderComposerFooter>
    </DialogContent>
  </Dialog>
}
