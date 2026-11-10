import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Field, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { reservationReason, reservationRemaining, validReservationQuantity, type ReservationInputRow } from './inpatient-reservation-input.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { formatFen } from './workspace-format.ts'

export function ReservationInputCard({ row, creating, locale, prefix, commonReason, disabled, selectionDisabled, problem, onSelect, onEdit, onRemove }: {
  row: ReservationInputRow; creating: boolean; locale: WorkspaceLocale; prefix: string; commonReason: string; disabled: boolean; selectionDisabled: boolean; problem: string | null
  onSelect: (checked: boolean) => void; onEdit: (change: Partial<ReservationInputRow>) => void; onRemove: () => void
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const preparing = creating || row.selected || row.reservation?.status === 'reserved'
  return <article aria-label={`${creating ? t('新增预留', 'Create reservation') : t('释放预留', 'Release reservation')} ${row.display}`} className="flex min-w-0 flex-col gap-3 rounded-md border p-3">
    {preparing ? <Field orientation="horizontal"><Checkbox id={`${prefix}-${row.id}`} checked={row.selected} disabled={disabled || selectionDisabled} onCheckedChange={onSelect} /><FieldLabel htmlFor={`${prefix}-${row.id}`} className="min-w-0 break-words">{t('选择', 'Select ')}{row.display}</FieldLabel></Field> : <h5 className="break-words font-medium">{row.display}</h5>}
    {creating ? <><p className="text-sm text-muted-foreground">{formatFen(row.priceFen, locale)}/{row.unit} · {t('当前手术预留预计，不计费', 'Estimate for this surgery; no charge')}</p>
      <Field data-invalid={!validReservationQuantity(row.quantity)}><FieldLabel htmlFor={`${prefix}-quantity-${row.id}`}>{t('预留数量 ', 'Reservation quantity ')}{row.display}</FieldLabel><Input id={`${prefix}-quantity-${row.id}`} type="number" min="1" max="1000" step="1" aria-invalid={!validReservationQuantity(row.quantity)} disabled={disabled} value={row.quantity} onChange={event => onEdit({ quantity: event.target.value })} /></Field></>
      : <ReservationEvidence row={row} locale={locale} />}
    {preparing ? <><Field><FieldLabel htmlFor={`${prefix}-override-${row.id}`}>{t('逐项理由 ', 'Item reason ')}{row.display}</FieldLabel><Input id={`${prefix}-override-${row.id}`} value={row.reason} disabled={disabled} maxLength={2000} onChange={event => onEdit({ reason: event.target.value })} /></Field>
      <p className="break-words text-sm">{t('最终理由：', 'Final reason: ')}{reservationReason(row, commonReason) || t('待填写', 'Required')}</p></> : null}
    {problem ? <p role="alert" className="text-sm text-destructive">{problem}</p> : null}
    {creating ? <Button type="button" variant="ghost" size="sm" className="self-start" disabled={disabled} aria-label={`${t('移除', 'Remove ')}${row.display}`} onClick={onRemove}>{t('移除本项输入', 'Remove item input')}</Button> : null}
  </article>
}

export function ReservationEvidence({ row, locale }: { row: ReservationInputRow | undefined; locale: WorkspaceLocale }) {
  const item = row?.reservation
  if (!item) return null
  const zh = locale === 'zh-CN'
  return <div className="min-w-0 break-words text-xs text-muted-foreground"><p>{zh ? `原量 ${item.quantity} · 已用 ${item.consumedQuantity} · 余量 ${reservationRemaining(item)} ${item.unit ?? ''} · 余量预计 ${formatFen(item.priceFen * reservationRemaining(item), locale)} · 状态 ${{ reserved: '预留中', replaced: '已转实际使用', released: '已释放' }[item.status]} · ${item.requestId ? '关联当前手术' : '未关联手术'}` : `Original ${item.quantity}; used ${item.consumedQuantity}; remaining ${reservationRemaining(item)} ${item.unit ?? ''}; estimate ${formatFen(item.priceFen * reservationRemaining(item), locale)}; status ${item.status}; ${item.requestId ? 'linked to current surgery' : 'unlinked'}`}</p><p>{zh ? `原预留理由：${item.reason}` : `Original reservation reason: ${item.reason}`}</p>
    {item.status === 'released' ? <p>{zh ? `已应用释放理由：${item.releaseReason || '未记录'}` : `Applied release reason: ${item.releaseReason || 'Not recorded'}`}</p> : null}</div>
}
