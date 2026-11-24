import type { LaboratorySpecimenContainer, SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import {
  groupInvestigationDispatchUnits,
  isBloodDrawSpecimenContainer,
  resolveLaboratorySpecimenContainer,
  type DispatchableInvestigationItem,
  type MergedInvestigationDispatchUnit,
} from '@clinmesh/core/laboratory-specimen-container'
import { Alert, AlertDescription } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@clinmesh/ui/components/dialog'
import { Input } from '@clinmesh/ui/components/input'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { z } from 'zod'
import { indicationLabel } from './doctor/laboratory-page.tsx'
import {
  investigationSendEntries,
  investigationSendScope,
  sameSendSnapshot,
  useInvestigationSendDrafts,
  type InvestigationSendEntry,
  type InvestigationSendSnapshot,
} from './inpatient-investigation-send-drafts.ts'
import { InpatientItemRow } from './inpatient-layout.tsx'
import { InpatientPrimaryAction } from './inpatient-workspace-actions.tsx'
import type { useInpatientWriteIntent } from './inpatient-write-intent.ts'
import { WorkspaceActionBar } from './workspace-card-layout.tsx'
import { getBatchFailureMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

type Facts = z.infer<typeof inpatientInvestigationsSchema>

function toListUnits(pool: readonly InvestigationSendEntry[]) {
  return groupInvestigationDispatchUnits(
    pool.map(entry => ({
      entry,
      id: entry.snapshot.id,
      kind: entry.snapshot.kind,
      referenceCode: entry.snapshot.referenceCode,
      specimen: entry.snapshot.specimen,
      specimenContainer: entry.snapshot.specimenContainer,
    })),
    { unmerged: item => item.entry.unavailable !== null },
  )
}

function summarizeDispatchUnits(units: readonly MergedInvestigationDispatchUnit<DispatchableInvestigationItem>[]) {
  let bloodTubeCount = 0
  let otherContainerCount = 0
  let labRequestCount = 0
  let examRequestCount = 0
  for (const unit of units) {
    if (unit.unitKind === 'tube') {
      if (isBloodDrawSpecimenContainer(unit.container)) bloodTubeCount += 1
      else otherContainerCount += 1
      labRequestCount += unit.items.length
    } else {
      examRequestCount += 1
    }
  }
  return {
    bloodTubeCount,
    examRequestCount,
    labRequestCount,
    otherContainerCount,
    totalContainerCount: bloodTubeCount + otherContainerCount,
    totalRequestCount: labRequestCount + examRequestCount,
  }
}

export function InpatientInvestigationSend({ admission, session, locale, data, loading, active, refresh, write, renderEntry }: {
  admission: InpatientAdmission; session: SessionContext; locale: WorkspaceLocale; data: Facts | undefined; loading: boolean; active: boolean;
  refresh: () => Promise<Facts | undefined>; write: ReturnType<typeof useInpatientWriteIntent>;
  renderEntry: (entry: InvestigationSendEntry, choice: ReactNode, metadata: ReactNode) => ReactNode;
}) {
  const zh = locale === 'zh-CN'
  const t = (cn: string, en: string) => zh ? cn : en
  const messages = getWorkspaceMessages(locale)
  const scope = investigationSendScope(session, admission.patientId, admission.id)
  const batch = useInvestigationSendDrafts({ scope, session, write })
  const [search, setSearch] = useState(''), [page, setPage] = useState(0), [review, setReview] = useState<InvestigationSendSnapshot[] | null>(null)
  const [discard, setDiscard] = useState(false), [checking, setChecking] = useState(false), [notice, setNotice] = useState('')
  const entries = data?.admissionId === admission.id ? investigationSendEntries(data) : []
  const unavailable = admission.status !== 'admitted' ? t('当前住院不在院，不能送检。', 'This admission is not active for dispatch.')
    : admission.financialStatus !== 'open' || admission.recordStatus === 'archived' ? t('住院已关闭或归档，不能送检。', 'This admission is closed or archived.')
      : loading || !data || data.admissionId !== admission.id ? t('请先读取完整检查申请，再核对送检。', 'Load current requests before reviewing dispatch.') : ''
  const selected = batch.rows.filter(row => row.selected)
  const selectedIds = new Set(selected.map(row => row.snapshot.id))
  const unknown = batch.items.some(item => item.status === 'unknown')
  const disabled = batch.blocked || !!unavailable || !active || checking
  const reason = (entry: InvestigationSendEntry | undefined) => !entry ? t('申请不在当前清单，请刷新核对。', 'Refresh this request before dispatch.')
    : entry.unavailable === 'sent' ? t('已送检，不能重复送检。', 'Already sent; dispatch cannot be repeated.')
      : entry.unavailable === 'state' ? t('当前状态不可送检。', 'This state does not allow dispatch.')
        : entry.unavailable === 'versions' ? t('申请信息不完整，请刷新核对。', 'Refresh the incomplete request details.') : ''
  const listUnits = toListUnits(entries)
  const allSendableTubePeers = (snapshot: InvestigationSendSnapshot, pool: readonly InvestigationSendEntry[]): InvestigationSendEntry[] => {
    if (snapshot.kind !== 'laboratory' || !resolveLaboratorySpecimenContainer(snapshot).mergeable) return []
    const units = pool === entries ? listUnits : toListUnits(pool)
    const containing = units.find(unit => unit.unitKind === 'tube' && unit.items.some(item => item.id === snapshot.id))
    return containing?.unitKind === 'tube' ? containing.items.map(item => item.entry) : []
  }
  const unselectedTubePeers = (snapshot: InvestigationSendSnapshot, pool: readonly InvestigationSendEntry[], chosenIds: ReadonlySet<string>): InvestigationSendEntry[] =>
    allSendableTubePeers(snapshot, pool).filter(peer => !chosenIds.has(peer.snapshot.id))
  const issue = (snapshot: InvestigationSendSnapshot) => {
    const entry = entries.find(entry => entry.snapshot.id === snapshot.id)
    const base = reason(entry) || (entry && !sameSendSnapshot(entry.snapshot, snapshot) ? t('申请已变化，请更新核对后重试。', 'The request changed; review its current details.') : '')
    if (base) return base
    if (selectedIds.has(snapshot.id) && unselectedTubePeers(snapshot, entries, selectedIds).length > 0) {
      return t('同采血管新增了待送检检验，请整管同步勾选。', 'New sendable tests were added to this specimen tube; select the full tube together.')
    }
    return ''
  }
  const queryText = search.trim().toLocaleLowerCase()
  const filteredUnits = listUnits.filter(unit => {
    if (queryText === '') return true
    if (unit.unitKind !== 'tube') {
      return `${unit.item.entry.snapshot.display} ${unit.item.entry.snapshot.specimen ?? ''}`.toLocaleLowerCase().includes(queryText)
    }
    const haystack = [
      unit.container.containerNameZh,
      unit.container.containerNameEn,
      unit.container.specimenCategoryZh,
      unit.container.specimenCategoryEn,
      unit.container.collectionRequirementZh,
      ...unit.items.map(item => `${item.entry.snapshot.display} ${item.entry.snapshot.specimen ?? ''}`),
    ].join(' ').toLocaleLowerCase()
    return haystack.includes(queryText)
  })
  const pageCount = Math.max(1, Math.ceil(filteredUnits.length / 10)), shownPage = Math.min(page, pageCount - 1)
  const visibleUnits = filteredUnits.slice(shownPage * 10, shownPage * 10 + 10)
  const eligible = visibleUnits.flatMap(unit => unit.unitKind === 'tube' ? unit.items.map(item => item.entry) : unit.item.entry.unavailable === null ? [unit.item.entry] : [])

  const current = useRef({ active, admission, session })
  current.current = { active, admission, session }
  const guard = () => current.current.active && current.current.admission.id === admission.id && current.current.admission.patientId === admission.patientId
    && current.current.admission.status === 'admitted' && current.current.admission.financialStatus === 'open' && current.current.admission.recordStatus !== 'archived'
    && current.current.session.user.id === session.user.id && JSON.stringify(current.current.session.actor) === JSON.stringify(session.actor)
  useEffect(() => { if (!active) { setReview(null); setDiscard(false) } }, [active])
  const select = (targetEntries: InvestigationSendEntry[], checked: boolean) => {
    if (!batch.select(targetEntries, checked)) setNotice(t('每次最多保留20项送检清单；请先移除不需要的项目，原选择保持不变。', 'Keep at most 20 dispatch items. Remove an item first; existing choices are retained.'))
    else setNotice('')
  }
  const kindLabel = (kind: InvestigationSendSnapshot['kind']) =>
    kind === 'laboratory' ? t('检验', 'Laboratory') : kind === 'examination' ? t('功能检查', 'Functional examination') : t('放射检查', 'Imaging')
  const details = (snapshot: InvestigationSendSnapshot) => <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
    <span>{kindLabel(snapshot.kind)}</span>
    <span>{snapshot.kind === 'laboratory' ? snapshot.specimen ? t(`标本：${snapshot.specimen}`, `Specimen: ${snapshot.specimen}`) : t('标本：原申请未提供，请按申请核对。', 'Specimen not provided; check the original request.') : t('前置条件：核对检查指征与原申请。', 'Prerequisite: verify the indication and original request.')}</span>
    <span>{t('指征：', 'Indication: ')}{snapshot.kind === 'laboratory' ? indicationLabel(snapshot.indication, messages) : snapshot.indication}</span>
  </div>
  const containerTitle = (container: LaboratorySpecimenContainer) =>
    zh ? `${container.containerNameZh} · ${container.specimenCategoryZh}` : `${container.containerNameEn} · ${container.specimenCategoryEn}`
  const containerReq = (container: LaboratorySpecimenContainer) =>
    zh ? container.collectionRequirementZh : container.collectionRequirementEn
  const containerBadge = (container: LaboratorySpecimenContainer, count: number) =>
    container.mergeable
      ? (count > 1 ? t(`1 管 · 合并 ${count} 项`, `1 tube · ${count} merged`) : t('1 管 · 1 项', '1 tube · 1 item'))
      : t(`独立核对采集 · ${count} 项`, `Separate collection · ${count} item`)

  const confirm = async () => {
    if (disabled || !review || !guard()) return
    setChecking(true); setNotice('')
    try {
      const facts = await refresh()
      if (!guard()) return
      const fresh = facts?.admissionId === admission.id ? investigationSendEntries(facts) : []
      const reviewIds = new Set(review.map(snapshot => snapshot.id))
      const hasUnreviewedPeer = review.some(snapshot => unselectedTubePeers(snapshot, fresh, reviewIds).length > 0)
      if (
        !facts
        || hasUnreviewedPeer
        || review.some(snapshot => !fresh.some(entry => entry.unavailable === null && sameSendSnapshot(entry.snapshot, snapshot)))
        || !batch.prepare(fresh)
      ) {
        setNotice(t('申请或送检状态已变化，请返回逐项更新核对；没有发送本次操作。', 'Requests or dispatch status changed. Return and review each item; this attempt was not sent.'))
        return
      }
      setReview(null)
      void batch.start(guard)
    } catch { setNotice(t('无法读取最新申请，请重试；选择和原输入已保留。', 'Current requests could not be loaded. Your choices are retained.')) }
    finally { setChecking(false) }
  }

  const draftUnits = groupInvestigationDispatchUnits(
    batch.rows.map(row => ({
      id: row.snapshot.id,
      kind: row.snapshot.kind,
      referenceCode: row.snapshot.referenceCode,
      row,
      specimen: row.snapshot.specimen,
      specimenContainer: row.snapshot.specimenContainer,
    })),
  )
  const selectedSummary = summarizeDispatchUnits(groupInvestigationDispatchUnits(selected.map(row => row.snapshot)))
  const reviewUnits = review ? groupInvestigationDispatchUnits(review) : []
  const reviewSummary = summarizeDispatchUnits(reviewUnits)

  const formatContainerPhrase = (bloodTubes: number, otherContainers: number) =>
    bloodTubes > 0 && otherContainers === 0
      ? t(`${bloodTubes} 管采血`, `${bloodTubes} blood tubes`)
      : bloodTubes === 0 && otherContainers > 0
        ? t(`${otherContainers} 份标本容器`, `${otherContainers} specimen containers`)
        : t(`${bloodTubes} 管采血 + ${otherContainers} 份其他标本`, `${bloodTubes} blood tubes + ${otherContainers} specimen containers`)

  const reviewDescription = reviewSummary.totalContainerCount > 0 && reviewSummary.examRequestCount === 0
    ? t(`本次住院 · 共 ${formatContainerPhrase(reviewSummary.bloodTubeCount, reviewSummary.otherContainerCount)}（合并 ${reviewSummary.labRequestCount} 项检验）`, `Current admission · ${formatContainerPhrase(reviewSummary.bloodTubeCount, reviewSummary.otherContainerCount)} (${reviewSummary.labRequestCount} lab tests)`)
    : reviewSummary.totalContainerCount > 0 && reviewSummary.examRequestCount > 0
      ? t(`本次住院 · 共 ${formatContainerPhrase(reviewSummary.bloodTubeCount, reviewSummary.otherContainerCount)}（合并 ${reviewSummary.labRequestCount} 项检验）· 另含 ${reviewSummary.examRequestCount} 项检查`, `Current admission · ${formatContainerPhrase(reviewSummary.bloodTubeCount, reviewSummary.otherContainerCount)} (${reviewSummary.labRequestCount} lab tests) · ${reviewSummary.examRequestCount} exams`)
      : t(`本次住院 · 已选 ${review?.length ?? 0} 项`, `Current admission · ${review?.length ?? 0} selected`)
  const reviewChanged = review?.some(snapshot => !!issue(snapshot)) === true

  const actionSummary = selectedSummary.totalContainerCount > 0 && selectedSummary.examRequestCount === 0
    ? t(`已选 ${formatContainerPhrase(selectedSummary.bloodTubeCount, selectedSummary.otherContainerCount)}（共 ${selected.length} 项送检申请）`, `${formatContainerPhrase(selectedSummary.bloodTubeCount, selectedSummary.otherContainerCount)} (${selected.length} requests) selected`)
    : selectedSummary.totalContainerCount > 0 && selectedSummary.examRequestCount > 0
      ? t(`已选 ${formatContainerPhrase(selectedSummary.bloodTubeCount, selectedSummary.otherContainerCount)} + ${selectedSummary.examRequestCount} 项检查（共 ${selected.length} 项）`, `${formatContainerPhrase(selectedSummary.bloodTubeCount, selectedSummary.otherContainerCount)} + ${selectedSummary.examRequestCount} exams (${selected.length} total)`)
      : t(`已选 ${selected.length} 项送检申请`, `${selected.length} requests selected`)

  return <section aria-label={t('集中送检', 'Investigation dispatch')} className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t('检查申请', 'Investigation requests')} · {entries.length}</h3><span className="text-xs text-muted-foreground">{t('按采血管自动合管 · 每次最多20项 · 送检不等于受理或执行完成', 'Auto-merged by specimen tube · Up to 20 items · Dispatch does not mean acceptance or execution')}</span></div>
    {unavailable ? <p role="status" className="text-sm text-muted-foreground">{unavailable}</p> : null}
    {batch.failed ? <Alert variant="destructive"><AlertDescription>{t('送检清单无法可靠读取或保存，已阻止发送；请先恢复原操作。', 'Dispatch list cannot be reliably read or saved; writes are blocked. Resolve the original attempt first.')}</AlertDescription></Alert> : null}
    {notice && !review ? <Alert><AlertDescription>{notice}</AlertDescription></Alert> : null}
    <div className="flex flex-wrap items-center gap-2">
      <Input className="min-w-0 flex-1 basis-48" aria-label={t('搜索送检申请', 'Search dispatch requests')} value={search} onChange={event => { setSearch(event.currentTarget.value); setPage(0) }} />
      <Button variant="outline" disabled={disabled || !eligible.length} onClick={() => select(eligible, true)}>{t('全选本页可送检申请', 'Select eligible requests on this page')}</Button>
      <Button variant="ghost" disabled={disabled || !selected.length} onClick={() => batch.deselectAll()}>{t('清空选择', 'Clear selection')}</Button>
      <span className="text-xs tabular-nums">{shownPage + 1}/{pageCount}</span><Button variant="ghost" disabled={!shownPage} onClick={() => setPage(shownPage - 1)}>{t('上一页', 'Previous')}</Button><Button variant="ghost" disabled={shownPage + 1 >= pageCount} onClick={() => setPage(shownPage + 1)}>{t('下一页', 'Next')}</Button>
    </div>
    {visibleUnits.map(unit => {
      if (unit.unitKind !== 'tube') {
        const entry = unit.item.entry
        return renderEntry(
          entry,
          <div className="flex flex-wrap items-center gap-2">
            <Checkbox aria-label={t(`选择送检：${entry.snapshot.display}`, `Select dispatch: ${entry.snapshot.display}`)} checked={batch.rows.some(row => row.snapshot.id === entry.snapshot.id && row.selected)} disabled={disabled || entry.unavailable !== null} onCheckedChange={checked => select([entry], checked)} />
            {reason(entry) ? <span className="text-xs text-muted-foreground">{reason(entry)}</span> : null}
          </div>,
          details(entry.snapshot),
        )
      }
      const tubeEntries = unit.items.map(item => item.entry)
      const allSelected = tubeEntries.every(entry => batch.rows.some(row => row.snapshot.id === entry.snapshot.id && row.selected))
      const titleText = containerTitle(unit.container)
      const namesSummary = tubeEntries.map(entry => entry.snapshot.display).join(zh ? '、' : ', ')
      return <InpatientItemRow
        key={unit.groupKey}
        title={<span className="inline-flex min-w-0 items-center gap-2"><span aria-hidden="true" className="clinmesh-specimen-cap" data-cap={unit.container.capColor} /><strong className="min-w-0 break-words">{titleText}</strong></span>}
        badge={<Badge variant="secondary">{containerBadge(unit.container, tubeEntries.length)}</Badge>}
        metadata={<span>{t('采集要求：', 'Collection: ')}{containerReq(unit.container)}</span>}
        actions={<>
          <Badge variant="outline">{t('待送检', 'Awaiting dispatch')}</Badge>
          <Checkbox
            aria-label={t(`选择采血管：${titleText}（${namesSummary}）`, `Select tube: ${titleText} (${namesSummary})`)}
            checked={allSelected}
            disabled={disabled}
            onCheckedChange={checked => select(tubeEntries, checked)}
          />
        </>}
      >
        <ul className="flex min-w-0 flex-col gap-1.5 text-xs">
          {tubeEntries.map(entry => <li key={entry.snapshot.id} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md bg-muted/40 px-2.5 py-1.5">
            <span className="min-w-0 flex-1 font-medium text-foreground break-words">{entry.snapshot.display}</span>
            <span className="text-muted-foreground">{t('指征：', 'Indication: ')}{indicationLabel(entry.snapshot.indication, messages)}</span>
          </li>)}
        </ul>
      </InpatientItemRow>
    })}
    {!loading && !visibleUnits.length ? <p className="text-sm text-muted-foreground">{t('没有匹配的检查申请。', 'No matching requests.')}</p> : null}
    {batch.rows.length || batch.failed ? <section aria-label={t('送检待处理清单', 'Dispatch drafts')} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="text-sm font-semibold">{t(`送检待处理清单（${batch.rows.length}/20）· 已选 ${selected.length} 项`, `Dispatch list (${batch.rows.length}/20) · ${selected.length} selected`)}</h4><Button variant="ghost" disabled={batch.busy || unknown || write.blocked} onClick={() => setDiscard(true)}>{t('丢弃送检清单', 'Discard dispatch drafts')}</Button></div>
      {draftUnits.map(unit => {
        if (unit.unitKind === 'non-specimen') {
          const row = unit.item.row
          const entry = entries.find(candidate => candidate.snapshot.id === row.snapshot.id)
          const problem = issue(row.snapshot)
          return <article key={unit.groupKey} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <label className="flex min-w-0 items-start gap-2">
                <Checkbox
                  aria-label={t(`待送检选择：${row.snapshot.display}`, `Draft selection: ${row.snapshot.display}`)}
                  checked={row.selected}
                  disabled={disabled || (!row.selected && !!problem)}
                  onCheckedChange={checked => {
                    if (!checked) batch.setSelectedIds([row.snapshot.id], false)
                    else if (entry) select([entry], true)
                  }}
                />
                <strong className="min-w-0 break-words text-sm">{row.snapshot.display}</strong>
              </label>
              <Button variant="ghost" disabled={disabled} onClick={() => batch.remove(row.snapshot.id)}>{t(`移除：${row.snapshot.display}`, `Remove: ${row.snapshot.display}`)}</Button>
            </div>
            {details(row.snapshot)}
            <p className="text-xs text-muted-foreground">{t('送检前核对清单：待送检。', 'Pre-dispatch review: awaiting dispatch.')}</p>
            {batch.items.some(item => item.row.revision === row.revision && item.status === 'unknown') ? <p role="status" className="text-sm text-destructive">{t('送检结果待确认，请恢复原送检。', 'Dispatch result unknown. Recover the original dispatch.')}</p> : null}
            {problem ? <p role="status" className="text-sm text-destructive">{problem}</p> : null}
            {entry?.unavailable === null && problem ? <Button variant="outline" disabled={disabled} onClick={() => select([entry], row.selected)}>{t(`更新核对：${row.snapshot.display}`, `Review current request: ${row.snapshot.display}`)}</Button> : null}
          </article>
        }
        const titleText = containerTitle(unit.container)
        const namesSummary = unit.items.map(item => item.row.snapshot.display).join(zh ? '、' : ', ')
        const sendableTubeEntries = unit.items
          .map(item => entries.find(candidate => candidate.snapshot.id === item.row.snapshot.id && candidate.unavailable === null))
          .filter((candidate): candidate is InvestigationSendEntry => candidate !== undefined)
        const anyTubeSelected = unit.items.some(item => item.row.selected)
        const tubeChecked = unit.items.every(item => item.row.selected)
        const allTubeProblems = unit.items.every(item => !!issue(item.row.snapshot))
        const fullTubePeers = sendableTubeEntries[0] ? allSendableTubePeers(sendableTubeEntries[0].snapshot, entries) : []
        return <article key={unit.groupKey} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <label className="flex min-w-0 flex-1 items-start gap-2">
              <Checkbox
                aria-label={t(`待送检采血管：${titleText}（${namesSummary}）`, `Draft tube: ${titleText} (${namesSummary})`)}
                checked={tubeChecked}
                disabled={disabled || (!anyTubeSelected && (sendableTubeEntries.length === 0 || allTubeProblems))}
                onCheckedChange={checked => {
                  if (!checked) batch.setSelectedIds(unit.items.map(item => item.row.snapshot.id), false)
                  else if (sendableTubeEntries.length > 0) select(fullTubePeers.length > 0 ? fullTubePeers : sendableTubeEntries, true)
                }}
              />
              <span className="inline-flex min-w-0 flex-wrap items-center gap-2 text-sm">
                <span aria-hidden="true" className="clinmesh-specimen-cap" data-cap={unit.container.capColor} />
                <strong className="min-w-0 break-words">{titleText}</strong>
                <Badge variant="secondary">{containerBadge(unit.container, unit.items.length)}</Badge>
              </span>
            </label>
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => batch.removeMany(unit.items.map(item => item.row.snapshot.id))}>
              {t(`移除采血管：${titleText}`, `Remove tube: ${titleText}`)}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('采集要求：', 'Collection: ')}{containerReq(unit.container)}</p>
          <div className="flex min-w-0 flex-col gap-1.5">
            {unit.items.map(({ row }) => {
              const entry = entries.find(candidate => candidate.snapshot.id === row.snapshot.id)
              const problem = issue(row.snapshot)
              const missingPeers = unselectedTubePeers(row.snapshot, entries, selectedIds)
              const isUnknown = batch.items.some(item => item.row.revision === row.revision && item.status === 'unknown')
              return <div key={row.snapshot.id} className="flex min-w-0 flex-col gap-1 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <strong className="min-w-0 flex-1 font-medium text-foreground break-words">{row.snapshot.display}</strong>
                  <span className="text-muted-foreground">{t('指征：', 'Indication: ')}{indicationLabel(row.snapshot.indication, messages)}</span>
                </div>
                {isUnknown ? <p role="status" className="text-sm text-destructive">{t('送检结果待确认，请恢复原送检。', 'Dispatch result unknown. Recover the original dispatch.')}</p> : null}
                {problem ? <p role="status" className="text-sm text-destructive">{problem}</p> : null}
                {problem ? <div className="flex flex-wrap gap-2">
                  {missingPeers.length > 0 ? <Button variant="outline" size="sm" disabled={disabled} onClick={() => select(allSendableTubePeers(row.snapshot, entries), true)}>{t('整管同步勾选', 'Select full tube')}</Button> : entry?.unavailable === null ? <Button variant="outline" size="sm" disabled={disabled} onClick={() => select([entry], row.selected)}>{t(`更新核对：${row.snapshot.display}`, `Review current request: ${row.snapshot.display}`)}</Button> : null}
                  {unit.items.length > 1 ? <Button variant="ghost" size="sm" disabled={disabled} onClick={() => batch.remove(row.snapshot.id)}>{t(`移除：${row.snapshot.display}`, `Remove: ${row.snapshot.display}`)}</Button> : null}
                </div> : null}
              </div>
            })}
          </div>
        </article>
      })}
    </section> : null}
    {batch.items.length ? <section aria-label={t('送检逐项结果', 'Dispatch results')} className="flex flex-col gap-2 text-sm"><h4 className="font-semibold">{t(`逐项送检结果 · 成功 ${batch.items.filter(item => item.status === 'success').length}/${batch.items.length}`, `Dispatch results · ${batch.items.filter(item => item.status === 'success').length}/${batch.items.length} succeeded`)}</h4>{batch.items.map(item => <p key={item.idempotencyKey}>{item.row.snapshot.display}：{item.status === 'success' ? t('已送检', 'Sent') : item.status === 'failed' ? t(`送检失败：${getBatchFailureMessage(item.error, locale)}`, `Dispatch failed: ${getBatchFailureMessage(item.error, locale)}`) : item.status === 'unknown' ? t('结果待确认，请恢复原送检；后续未发送。', 'Result unknown. Recover the original dispatch; later items were not sent.') : t('尚未发送，请重新核对。', 'Not sent; review before proceeding.')}</p>)}</section> : null}
    <InpatientPrimaryAction stage="investigations"><WorkspaceActionBar tone={disabled || !selected.length || selected.some(row => issue(row.snapshot)) ? 'blocked' : 'normal'} summary={actionSummary} reason={unknown ? t('先恢复原送检，余项须重新核对。', 'Recover the original dispatch, then review the remaining items.') : t('按采血管合管核对标本与前置条件；不生成受理、报告或已阅记录。', 'Verify specimen tubes and prerequisites. Dispatch does not create reports or acknowledgement.')} action={unknown ? <Button disabled={batch.busy || batch.failed || !guard()} onClick={() => { void batch.recover(guard) }}>{t('恢复原送检', 'Recover original dispatch')}</Button> : <Button disabled={disabled || !selected.length || selected.some(row => issue(row.snapshot))} onClick={() => { setNotice(''); setReview(selected.map(row => row.snapshot)) }}>{t('集中送检', 'Review dispatch')}</Button>} /></InpatientPrimaryAction>
    <Dialog open={review !== null && active} pending={checking} onOpenChange={open => { if (!open) setReview(null) }}><DialogContent className="sm:max-w-[720px]"><DialogHeader><DialogTitle>{t('集中送检核对', 'Review investigation dispatch')}</DialogTitle><DialogDescription>{admission.patientName} · {reviewDescription}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
        {notice || reviewChanged ? <Alert variant="destructive"><AlertDescription>{notice || t('申请已变化，请返回更新核对后再确认。', 'Requests changed. Return and review current details.')}</AlertDescription></Alert> : null}
        {reviewUnits.map(unit => {
          if (unit.unitKind === 'non-specimen') {
            return <article key={unit.groupKey} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="min-w-0 flex-1 break-words text-sm">{unit.item.display}</strong>
                <Badge variant="outline">{t('待送检', 'Awaiting dispatch')}</Badge>
              </div>
              {details(unit.item)}
            </article>
          }
          const titleText = containerTitle(unit.container)
          return <article key={unit.groupKey} className="flex min-w-0 flex-col gap-2 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
                <span aria-hidden="true" className="clinmesh-specimen-cap" data-cap={unit.container.capColor} />
                <strong className="min-w-0 break-words">{titleText}</strong>
                <Badge variant="secondary">{containerBadge(unit.container, unit.items.length)}</Badge>
              </span>
              <Badge variant="outline">{t('待送检', 'Awaiting dispatch')}</Badge>
            </div>
            <p className="text-xs text-muted-foreground">{t('采集要求：', 'Collection: ')}{containerReq(unit.container)}</p>
            <ul className="flex min-w-0 flex-col gap-1.5 text-xs">
              {unit.items.map(snapshot => <li key={snapshot.id} className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md bg-muted/40 px-2.5 py-1.5">
                <span className="min-w-0 flex-1 font-medium text-foreground break-words">{snapshot.display}</span>
                <span className="text-muted-foreground">{t('检验', 'Laboratory')} · {t('指征：', 'Indication: ')}{indicationLabel(snapshot.indication, messages)}</span>
              </li>)}
            </ul>
          </article>
        })}
        <p className="text-xs text-muted-foreground">{t('按采血管核对后确认，底层各申请仍独立办理。已成功项保留，失败项保留输入。', 'Confirm after reviewing specimen tubes. Underlying requests are processed individually; successful items remain complete and failed items retain their input.')}</p>
      </div>
      <DialogFooter><DialogClose render={<Button variant="outline" />}>{t('返回修改', 'Back')}</DialogClose><Button disabled={disabled || reviewChanged} onClick={() => { void confirm() }}>{t('确认送检', 'Confirm dispatch')}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={discard && active} onOpenChange={setDiscard}><DialogContent><DialogHeader><DialogTitle>{t('丢弃送检清单', 'Discard dispatch drafts')}</DialogTitle><DialogDescription>{t('仅丢弃当前患者本次住院的未提交选择和结果展示；不会取消申请或撤销已送检记录。', 'Discard only this admission’s pending choices and result display. Requests and completed dispatch remain.')}</DialogDescription></DialogHeader><DialogFooter><DialogClose render={<Button variant="outline" />}>{t('保留清单', 'Keep drafts')}</DialogClose><Button disabled={batch.busy || unknown || write.blocked} onClick={() => { if (batch.clear()) setDiscard(false) }}>{t('确认丢弃', 'Confirm discard')}</Button></DialogFooter></DialogContent></Dialog>
  </section>
}
