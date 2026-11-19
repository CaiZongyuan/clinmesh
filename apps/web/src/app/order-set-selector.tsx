import {
  orderSetTemplateIds,
  type OrderSetDraft,
  type OrderSetDraftItem,
  type OrderSetItemKind,
  type OrderSetScope,
  type OrderSetTemplateId,
} from '@clinmesh/contracts/order-set-templates'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { getOrderSetDrafts } from './api-client.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

export interface OrderSetApplyResult {
  addedCount: number
  error?: string
  extraNote?: string
  removedCount?: number | undefined
  reviewCount: number
}

export type OrderSetTarget =
  | { caseId: string; scope: 'outpatient' }
  | { admissionId: string; scope: 'inpatient' }

const [cpId, baseId, cinId, secId] = orderSetTemplateIds
const both: readonly OrderSetScope[] = ['outpatient', 'inpatient']
const ipOnly: readonly OrderSetScope[] = ['inpatient']
const examLab: readonly OrderSetItemKind[] = ['examination', 'laboratory']
const optionRows: ReadonlyArray<readonly [OrderSetTemplateId, readonly OrderSetItemKind[], readonly OrderSetScope[], string, string]> = [
  [cpId, examLab, both, 'Chest pain stat work-up', '胸痛首诊急查'],
  [baseId, examLab, ipOnly, 'CAD admission baseline', '冠心病入院基线评估'],
  [cinId, ['medication', 'laboratory'], ipOnly, 'Contrast nephropathy perioperative hydration', '对比剂肾损高危围术期水化'],
  [secId, ['medication'], both, 'CAD/PCI secondary prevention', '冠心病/PCI 二级预防'],
]
export const orderSetSelectorOptions = Object.freeze(
  optionRows.map(([id, itemKinds, scopes, titleEn, titleZh]) => ({ id, itemKinds, scopes, titleEn, titleZh })),
)

export function orderSetExcludedIds(draft: OrderSetDraft, kind: OrderSetItemKind): Set<string> {
  return new Set(draft.items.flatMap(i => i.kind === kind && i.disposition === 'excluded' && i.matchedCatalogId !== null ? [i.matchedCatalogId] : []))
}

function badgeFor(d: OrderSetDraftItem['disposition'], zh: boolean): [string, 'outline' | 'warning'] | undefined {
  if (d === 'excluded') return [zh ? '已按禁忌剔除' : 'Excluded', 'warning']
  if (d === 'needs-review') return [zh ? '待核实' : 'Needs verification', 'warning']
  return d === 'unavailable' ? [zh ? '暂不可开立' : 'Unavailable', 'outline'] : undefined
}

export function OrderSetSelectorBar({
  disabled = false,
  excludeKinds,
  itemKinds,
  locale,
  onApply,
  target,
}: {
  disabled?: boolean | undefined
  excludeKinds?: readonly OrderSetItemKind[] | undefined
  itemKinds?: readonly OrderSetItemKind[] | undefined
  locale: WorkspaceLocale
  onApply: (draft: OrderSetDraft) => OrderSetApplyResult
  target: OrderSetTarget
}): React.JSX.Element | null {
  const zh = locale === 'zh-CN'
  const t = (cn: string, en: string) => (zh ? cn : en)
  const id = useId()
  const qc = useQueryClient()
  const list = orderSetSelectorOptions.filter(o =>
    o.scopes.includes(target.scope)
    && (!itemKinds || o.itemKinds.some(k => itemKinds.includes(k)))
    && (!excludeKinds || !o.itemKinds.some(k => excludeKinds.includes(k))))
  const [picked, setPicked] = useState<OrderSetTemplateId | undefined>(list[0]?.id)
  const active = picked && list.some(o => o.id === picked) ? picked : list[0]?.id
  const tid = target.scope === 'outpatient' ? target.caseId : target.admissionId
  const key = `${target.scope}:${tid}`

  const run = useMutation({
    mutationFn: async (v: { id: OrderSetTemplateId; key: string }) => {
      const b = await qc.fetchQuery({
        queryFn: ({ signal }) => getOrderSetDrafts(target, v.id, signal),
        queryKey: ['order-set-drafts', target.scope, tid, v.id],
        staleTime: 0,
      })
      const d = b.drafts.find(x => x.template.id === v.id) ?? b.drafts[0]
      return d ? { draft: d, key: v.key, outcome: onApply(d) } : null
    },
  })

  if (!list.length || !active) return null

  const busy = run.isPending
  const cur = run.data?.key === key ? run.data : null
  const { addedCount: add, error: applyErr, extraNote, removedCount: rm = 0, reviewCount: rev } = cur?.outcome ?? { addedCount: 0, reviewCount: 0 }
  const err = run.variables?.key === key ? run.error : null
  const alert = err ? `${t('组套预筛读取失败：', 'Failed to load order set screening: ')}${getWorkspaceErrorMessage(err, getWorkspaceMessages(locale))}` : applyErr
  const flagged = cur?.draft.items.filter(i => badgeFor(i.disposition, zh) !== undefined) ?? []

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-md border bg-muted/30 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{t('专病组套', 'Specialty order set')}</span>
        <div className="min-w-40 flex-1 max-w-xs">
          <WorkspaceSelect
            ariaLabel={t('专病组套', 'Specialty order set')}
            disabled={disabled || busy}
            id={id}
            items={list.map(o => ({ label: zh ? o.titleZh : o.titleEn, value: o.id }))}
            onValueChange={v => { const m = list.find(o => o.id === v); if (m) setPicked(m.id) }}
            value={active}
          />
        </div>
        <Button disabled={disabled || busy} onClick={() => { if (!disabled && !busy) run.mutate({ id: active, key }) }} size="sm" type="button" variant="outline">
          {busy ? t('正在预筛…', 'Screening…') : t('套用专病组套', 'Apply order set')}
        </Button>
      </div>
      {alert ? <Alert variant="destructive"><AlertDescription>{alert}</AlertDescription></Alert> : null}
      {cur && !applyErr ? (
        <div className="flex flex-col gap-1.5 text-xs" role="status">
          <p className="font-medium">
            {t(`已套用「${cur.draft.template.titleZh}」：加入待开清单 ${add} 项`, `Applied "${cur.draft.template.titleEn}": added ${add} items`)}
            {rev > 0 ? t(`（其中待核实 ${rev} 项默认未勾选，核实后再勾选开立）`, ` (${rev} require verification and start unselected)`) : ''}
            {cur.draft.counts.excluded > 0 ? t(` · 已按禁忌剔除 ${cur.draft.counts.excluded} 项`, ` · ${cur.draft.counts.excluded} excluded`) : ''}
            {rm > 0 ? t(` · 已从待开清单移除受限项 ${rm} 项`, ` · removed ${rm} restricted items`) : ''}
            {extraNote ? ` · ${extraNote}` : ''}
          </p>
          {flagged.length > 0 ? (
            <ul className="flex flex-col gap-1 text-muted-foreground">
              {flagged.map(i => {
                const [label, variant] = badgeFor(i.disposition, zh)!
                return (
                  <li className="flex flex-wrap items-baseline gap-1.5" key={i.key}>
                    <Badge variant={variant}>{label}</Badge>
                    <span className="font-medium text-foreground">{i.titleZh}</span>
                    <span>{i.reasons.map(r => r.messageZh).join(' ')}</span>
                  </li>
                )
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
