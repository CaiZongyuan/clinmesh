import type { DrgGroupingResult } from '@clinmesh/contracts/drg'
import type { ReactNode } from 'react'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function drgGroupingStatusLabel(status: DrgGroupingResult['status'], locale: WorkspaceLocale): string {
  const zh = locale === 'zh-CN'
  return {
    grouped: zh ? '已分组' : 'Grouped',
    ungroupable: zh ? '无法入组' : 'Ungroupable',
    ambiguous: zh ? '分组有歧义' : 'Ambiguous group',
    'invalid-input': zh ? '分组依据不完整' : 'Incomplete grouping input',
  }[status]
}

/** 四项事实按正文容器排列；窄工作区保留两列，不改变数值的来源和口径。 */
export function DrgSummaryFacts({ facts }: { facts: readonly { label: string; value: ReactNode }[] }) {
  return <div className="@container/drg-summary min-w-0">
    <dl className="grid grid-cols-2 gap-x-5 gap-y-3 @min-[42rem]/drg-summary:grid-cols-4">
      {facts.map(fact => <div key={fact.label} className="min-w-0">
        <dt className="text-xs text-muted-foreground">{fact.label}</dt>{' '}
        <dd className="mt-1 break-words text-sm font-semibold tabular-nums">{fact.value}</dd>
      </div>)}
    </dl>
  </div>
}

function formatDrgStep(step: DrgGroupingResult['steps'][number], result: DrgGroupingResult, zh: boolean): string {
  const code = step.matchedCode ? (zh ? `（命中编码 ${step.matchedCode}）` : ` (code ${step.matchedCode})`) : ''
  if (step.basis.includes('检查候选分支') || step.result.includes('检查候选')) {
    return zh ? `主诊断编码入组核对${code} → 归入 ${result.mdcCode ?? step.result.replace(/^检查候选\s*/, '')} 疾病大类` : `Primary diagnosis check${code} → ${result.mdcCode ?? step.result}`
  }
  if (step.basis.includes('按原程序顺序核对终端条件') || step.result.startsWith('满足 ')) {
    const target = result.drgCode ?? step.result.replace(/^满足\s*/, '')
    return zh ? `核对主要操作与合并症条件${code} → 落入病组 ${target}${result.adrgCode ? `（ADRG ${result.adrgCode}）` : ''}` : `Procedure & comorbidity check${code} → DRG ${target}`
  }
  return `${step.basis}${step.matchedCode ? ` · ${zh ? '命中编码 ' : 'Matched code '}${step.matchedCode}` : ''} · ${step.result}`
}

export function DrgGroupingEvidence({ result, locale }: { result: DrgGroupingResult; locale: WorkspaceLocale }) {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  return <>
    {result.reason ? <p className="text-sm text-muted-foreground">{result.reason}</p> : null}
    {result.steps.length > 0 ? <details className="clinmesh-inpatient-disclosure"><summary>{t('查看分组依据', 'Grouping basis')}</summary><ol className="list-inside list-decimal text-sm">{result.steps.map((step, index) => <li key={index}>{formatDrgStep(step, result, zh)}</li>)}</ol></details> : null}
  </>
}
