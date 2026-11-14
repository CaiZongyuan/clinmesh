import type { InpatientEquivalentMaterialSuggestion } from '@clinmesh/contracts/inpatient-pci-selection'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function EquivalentMaterialAdvice({ suggestions, locale, disabled, onPick, undo, assistantExplanation }: {
  suggestions: readonly InpatientEquivalentMaterialSuggestion[]; locale: WorkspaceLocale; disabled: boolean;
  onPick(suggestion: InpatientEquivalentMaterialSuggestion): void;
  assistantExplanation?: string | null | undefined;
  undo?: { savingsFen: number; onUndo(): void } | undefined
}) {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  if (undo) return <p className="text-xs text-muted-foreground">{t('已换用等效耗材，预计少 ', 'Equivalent material selected; projected saving ')}{formatFen(undo.savingsFen, locale)}。<Button type="button" variant="link" size="sm" className="h-auto px-1 text-xs text-info" disabled={disabled} onClick={undo.onUndo}>{t('换回原耗材', 'Restore original material')}</Button></p>
  if (suggestions.length === 0) return null
  return <div className="flex min-w-0 flex-col gap-2 text-xs">
    {suggestions.map(suggestion => <p key={`${suggestion.from.id}-${suggestion.to.id}`} className="break-words leading-relaxed text-info">
      <span className="mr-2 font-medium">{t('等效耗材', 'Equivalent material')}</span>
      {t('做完预计 ', 'Projected total ')}{formatFen(suggestion.beforeTotalFen, locale)}{t('，费用已接近支付参考。同类别、同规格且在兼容候选内的等效耗材：', '; charges are near the payment reference. A compatible equivalent of the same category and specification: ')}
      <strong className="font-medium">{suggestion.to.display}</strong> {formatFen(suggestion.to.chargeDefinition.priceFen, locale)}/{suggestion.to.chargeDefinition.unit}{t('，单价少 ', '; unit price saving ')}{formatFen(suggestion.unitSavingsFen, locale)}{t('；换后预计 ', '; projected total after replacement ')}{formatFen(suggestion.afterTotalFen, locale)}。
      <Button type="button" variant="link" size="sm" className="h-auto px-1 text-xs text-info" disabled={disabled} onClick={() => onPick(suggestion)}>{t('换成这个', 'Use this equivalent')}</Button>
    </p>)}
    {assistantExplanation ? <p className="break-words leading-relaxed"><Badge variant="secondary" className="mr-2">{t('助手', 'Assistant')}</Badge>{assistantExplanation}</p> : null}
  </div>
}
