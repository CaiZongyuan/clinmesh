import { Button } from '@clinmesh/ui/components/button'
import { CopyIcon } from 'lucide-react'
import { useState } from 'react'
import type { WorkspaceLocale } from './workspace-i18n.ts'

/** 患者头部的住院号：过长时中间截断，悬停显示全文，可以复制。 */
export function InpatientNumber({ locale, number }: { locale: WorkspaceLocale; number: string }): React.JSX.Element {
  // 不同号码各自拥有复制反馈，包括迟到的剪贴板响应。
  return <InpatientNumberValue key={number} locale={locale} number={number} />
}

function InpatientNumberValue({ locale, number }: { locale: WorkspaceLocale; number: string }): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const [result, setResult] = useState<'copied' | 'failed'>()
  return <span className="inline-flex items-center gap-1" data-inpatient-number>
    <span className="font-mono tabular-nums" title={number}>{t('住院号 ', 'Inpatient no. ')}{number.length > 14 ? `${number.slice(0, 7)}…${number.slice(-4)}` : number}</span>
    <Button aria-label={`${t('复制住院号', 'Copy inpatient number')} ${number}`} onClick={async () => {
      setResult(undefined)
      try { await navigator.clipboard.writeText(number); setResult('copied') } catch { setResult('failed') }
    }} size="icon-xs" type="button" variant="ghost"><CopyIcon aria-hidden="true" /></Button>
    {result === undefined ? null : <span className="text-xs text-muted-foreground" role={result === 'failed' ? 'alert' : 'status'}>
      {result === 'copied' ? t('已复制', 'Copied') : t('复制失败', 'Copy failed')}
    </span>}
  </span>
}

/** 队列行只显示住院号尾号，悬停显示全文。 */
export function InpatientNumberTail({ locale, number }: { locale: WorkspaceLocale; number: string }): React.JSX.Element {
  return <span className="font-mono tabular-nums" title={number}>{locale === 'zh-CN' ? '尾号 ' : 'No. …'}{number.slice(-4)}</span>
}
