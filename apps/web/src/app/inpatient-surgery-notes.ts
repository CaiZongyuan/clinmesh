import type { InpatientMaterialPlan } from '@clinmesh/contracts/inpatient-material-plan'
import type { inpatientSurgeryExecutionSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { inpatientDrgReviewTodoSchema } from '@clinmesh/contracts/inpatient-drg-review'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { z } from 'zod'
import type { CompletionDraftRow, CompletionRelease } from './inpatient-surgery-completion-draft.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function completionQuantities(rows: CompletionDraftRow[], plan: InpatientMaterialPlan | undefined) {
  const keys = new Set([...rows.map(row => `${row.materialId}@${row.catalogVersion}`), ...plan?.items.map(item => `${item.materialId}@${item.catalogVersion}`) ?? []])
  return [...keys].map(key => {
    const actual = rows.filter(row => `${row.materialId}@${row.catalogVersion}` === key)
    const expected = plan?.items.find(item => `${item.materialId}@${item.catalogVersion}` === key)
    const quantity = actual.reduce((sum, row) => sum + Number(row.quantity), 0)
    const planned = plan ? expected?.quantity ?? 0 : null
    return { key, display: expected?.display ?? actual[0]!.display, unit: expected?.unit ?? actual[0]?.unit ?? '',
      quantity, planned, difference: planned === null ? null : quantity - planned }
  })
}

export function completionReviewNote(rows: CompletionDraftRow[], plan: InpatientMaterialPlan | undefined,
  execution: z.infer<typeof inpatientSurgeryExecutionSchema>, releases: CompletionRelease[], locale: WorkspaceLocale) {
  const zh = locale === 'zh-CN'
  const changed = rows.some(row => Number(row.quantity) !== row.previousQuantity)
  const lead = changed ? zh ? '最终用量已按逐项核实调整' : 'Final quantities adjusted after item review'
    : zh ? '最终用量按术中已登记量核实' : 'Final quantities verified against recorded use'
  if (!plan) return `${lead}${zh ? '；未取得可核验的术前计划，计划差异待核实。' : '; no verifiable preoperative plan is available; plan differences need review.'}`
  const differences = completionQuantities(rows, plan).filter(row => row.difference !== 0)
  if (differences.length === 0) return changed ? `${lead}${zh ? '，与术前计划一致。' : '; consistent with the preoperative plan.'}`
    : zh ? '最终用量与术中登记、术前计划一致。' : 'Final quantities match recorded use and the preoperative plan.'
  const details = differences.map(row => {
    const notes = [...new Set(execution.materialHistory.filter(use => !use.correction && `${use.item.id}@${use.item.version}` === row.key).map(use => use.note))]
    return row.difference! > 0 ? `${row.display}${zh ? '多用' : ' extra '}${row.difference} ${row.unit}${notes.length ? `，${notes.join('；')}` : ''}`
      : `${row.display}${zh ? '未用' : ' unused '}${-row.difference!} ${row.unit}，${releases.some(release => rows.some(item => item.reservationId === release.reservationId && `${item.materialId}@${item.catalogVersion}` === row.key)) ? zh ? '释放预留' : 'release reservation' : zh ? '保留预留' : 'retain reservation'}`
  })
  return `${lead}；${details.join('；')}。`.slice(0, 2000)
}

export function postoperativeDispositionNote(todo: z.infer<typeof inpatientDrgReviewTodoSchema>,
  executions: z.infer<typeof inpatientSurgeryExecutionSchema>[], reservations: InpatientMaterialReservation[], locale: WorkspaceLocale) {
  const zh = locale === 'zh-CN', execution = executions.find(item => item.id === todo.executionId)
  const notes = [...new Set(execution?.materialHistory.filter(use => !use.correction && use.item.id === todo.materialId).map(use => use.note) ?? [])]
  if (todo.kind === 'unused-plan') {
    const remaining = reservations.filter(item => item.requestId === todo.requestId && item.materialId === todo.materialId && item.quantity > item.consumedQuantity)
    const disposition = remaining.length === 0 ? zh ? '预留状态待核实' : 'reservation disposition needs review'
      : remaining.every(item => item.status === 'released') ? zh ? '未用预留已释放' : 'unused reservations released'
        : zh ? '未用预留保留，后续按需释放' : 'unused reservations retained for later review'
    return `${todo.display}${zh ? '未使用原计划全部数量' : ': not all planned quantities were used'}；${disposition}。`
  }
  return `${todo.explanation}${notes.length ? `${zh ? '登记依据：' : 'Recorded reason: '}${notes.join('；')}` : ''}`.slice(0, 2000)
}
