import type { InpatientMaterialPlan } from '@clinmesh/contracts/inpatient-material-plan'
import type { inpatientSurgeryExecutionSchema } from '@clinmesh/contracts/inpatient-surgery'
import type { inpatientDrgReviewTodoSchema } from '@clinmesh/contracts/inpatient-drg-review'
import type { InpatientMaterialReservation } from '@clinmesh/contracts/inpatient-drg-simulation'
import type { z } from 'zod'
import { remainingAfterCompletion, type CompletionDraftRow, type CompletionRelease } from './inpatient-surgery-completion-draft.ts'
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
  execution: z.infer<typeof inpatientSurgeryExecutionSchema>, releases: CompletionRelease[], locale: WorkspaceLocale, reservations: InpatientMaterialReservation[]) {
  const zh = locale === 'zh-CN'
  const changed = rows.some(row => Number(row.quantity) !== row.previousQuantity)
  const lead = changed ? zh ? '最终用量已按逐项核实调整' : 'Final quantities adjusted after item review'
    : zh ? '最终用量按术中已登记量核实' : 'Final quantities verified against recorded use'
  if (!plan) return `${lead}${zh ? '；未取得可核验的术前计划，计划差异待核实。' : '; no verifiable preoperative plan is available; plan differences need review.'}`
  const differences = completionQuantities(rows, plan).filter(row => row.difference !== 0)
  if (differences.length === 0) return changed ? `${lead}${zh ? '，与术前计划一致。' : '; consistent with the preoperative plan.'}`
    : zh ? '最终用量与术中登记、术前计划一致。' : 'Final quantities match recorded use and the preoperative plan.'
  const history = retainedMaterialHistory(materialHistoryInOriginalOrder(execution.materialHistory), rows)
  const details = differences.map(row => {
    const notes = excessUseNotes(history.filter(use => `${use.item.id}@${use.item.version}` === row.key), row.planned ?? 0)
    return row.difference! > 0 ? `${row.display}${zh ? '多用' : ' extra '}${row.difference} ${row.unit}${notes.length ? `，${notes.join('；')}` : ''}`
      : `${row.display}${zh ? '未用' : ' unused '}${-row.difference!} ${row.unit}，${reservationDisposition(reservations.filter(item => item.requestId === plan.requestId && `${item.materialId}@${item.catalogVersion}` === row.key && (plan.reservationIds.length === 0 || plan.reservationIds.includes(item.id))), locale, releases, rows)}`
  })
  return `${lead}；${details.join('；')}。`.slice(0, 2000)
}

export function postoperativeDispositionNote(todo: z.infer<typeof inpatientDrgReviewTodoSchema>,
  executions: z.infer<typeof inpatientSurgeryExecutionSchema>[], reservations: InpatientMaterialReservation[], locale: WorkspaceLocale,
  disposition: 'confirm' | 'follow-up' = 'confirm') {
  const zh = locale === 'zh-CN', execution = executions.find(item => item.id === todo.executionId)
  if (todo.kind === 'unused-plan') {
    const disposition = reservationDisposition(reservations.filter(item => item.requestId === todo.requestId && item.materialId === todo.materialId), locale)
    return `${todo.display}${zh ? '未使用原计划全部数量' : ': not all planned quantities were used'}；${disposition}。`
  }
  const history = execution?.materialHistory ?? []
  const sources = new Set(todo.evidence.filter(reference => reference.startsWith('InpatientSurgeryMaterial/')))
  const materialHistory = materialHistoryInOriginalOrder(history).filter(use => use.item.id === todo.materialId
    && (sources.size === 0 || sources.has(`InpatientSurgeryMaterial/${use.id}`)))
  const notes = todo.kind === 'extra-use' && todo.plannedQuantity !== null
    ? excessUseNotes(materialHistory, todo.plannedQuantity).filter(note => note.trim())
    : [...new Set(history.filter(use => !use.correction && use.item.id === todo.materialId).map(use => use.note))]
  const loadedSources = new Set(materialHistory.map(use => `InpatientSurgeryMaterial/${use.id}`))
  const hasCompleteHistory = materialHistory.reduce((quantity, use) => quantity + use.quantity, 0) === todo.actualQuantity
    && [...sources].every(source => loadedSources.has(source))
  if (todo.kind === 'extra-use' && todo.plannedQuantity !== null && todo.actualQuantity !== null
    && todo.actualQuantity > todo.plannedQuantity && notes.length > 0 && hasCompleteHistory) {
    const quantity = todo.actualQuantity - todo.plannedQuantity
    const unit = materialHistory[0]?.item.chargeDefinition.unit
    const amount = `${quantity}${unit ? ` ${unit}` : ''}`
    const conclusion = disposition === 'follow-up' ? zh ? '需继续跟进核实。' : 'further review needed.'
      : zh ? '无需进一步处理。' : 'no further action needed.'
    return (zh ? `术中多用 ${amount}，${notes.join('；')}；已在登记时说明，${conclusion}`
      : `${amount} extra used during surgery: ${notes.join('; ')}. Reason recorded during surgery; ${conclusion}`).slice(0, 2000)
  }
  return `${todo.explanation}${notes.length ? `${zh ? '登记依据：' : 'Recorded reason: '}${notes.join('；')}` : ''}`.slice(0, 2000)
}

function excessUseNotes(history: z.infer<typeof inpatientSurgeryExecutionSchema>['materialHistory'], plannedQuantity: number) {
  let used = 0
  const notes = new Set<string>()
  for (const use of history) {
    used += use.quantity
    if (used > plannedQuantity) notes.add(use.note)
  }
  return [...notes]
}

/** 对齐核实事务的末笔先减：每行先保留来源列表前部用量，新增无历史量不借用原登记原因。 */
function retainedMaterialHistory(history: z.infer<typeof inpatientSurgeryExecutionSchema>['materialHistory'], rows: CompletionDraftRow[]) {
  const byId = new Map(history.map(use => [use.id, use]))
  const retained = new Map<string, number>()
  for (const row of rows) {
    let remaining = Number(row.quantity)
    for (const id of row.materialUseIds) {
      const use = byId.get(id)
      if (!use || use.item.id !== row.materialId || use.item.version !== row.catalogVersion) continue
      const quantity = Math.min(use.quantity, Math.max(0, remaining))
      retained.set(id, quantity)
      remaining -= quantity
    }
  }
  return history.flatMap(use => {
    const quantity = retained.get(use.id) ?? 0
    return quantity > 0 ? [{ ...use, quantity }] : []
  })
}

/** 更正替代原笔的事实，累计时保留原笔的位置；替换链只计最终有效记录一次。 */
function materialHistoryInOriginalOrder(history: z.infer<typeof inpatientSurgeryExecutionSchema>['materialHistory']) {
  const byId = new Map(history.map(use => [use.id, use]))
  const replacements = new Set(history.flatMap(use => use.correction?.replacementMaterialUseId ? [use.correction.replacementMaterialUseId] : []))
  const visited = new Set<string>()
  return history.filter(use => !replacements.has(use.id)).flatMap(original => {
    let use: typeof original | undefined = original
    while (use && !visited.has(use.id)) {
      visited.add(use.id)
      if (!use.correction) return [use]
      use = use.correction.replacementMaterialUseId ? byId.get(use.correction.replacementMaterialUseId) : undefined
    }
    return []
  })
}

function reservationDisposition(reservations: InpatientMaterialReservation[], locale: WorkspaceLocale, releases: CompletionRelease[] = [], rows?: CompletionDraftRow[]) {
  const zh = locale === 'zh-CN'
  if (reservations.length === 0) return zh ? '预留状态待核实' : 'Reservation disposition needs review'
  const closed = reservations.filter(item => item.status === 'released' || item.releaseReason != null)
  if (closed.length === reservations.length) return zh ? '预留已释放' : 'Reservations already released'
  const open = reservations.filter(item => !closed.includes(item) && (rows ? remainingAfterCompletion(item, rows) ?? 0 : item.quantity - item.consumedQuantity) > 0)
  if (open.length === 0) return zh ? '原预留无剩余量' : 'No reservation remainder'
  const selected = open.filter(item => releases.some(release => release.reservationId === item.id))
  if (selected.length === open.length) return zh ? '释放预留' : 'Release reservations'
  if (selected.length > 0) return zh ? '部分释放，其余保留' : 'Release selected reservations and retain the remainder'
  return closed.length > 0 ? zh ? '部分预留已释放，其余保留' : 'Some reservations already released; retain the remainder'
    : zh ? '保留预留' : 'Retain reservations'
}
