import type {
  PathologyCoverage,
  PathologyExamCode,
  PathologyExamPreparation,
  PathologyFactName,
  PathologyFactValue,
  PathologyPreparationReason,
} from '@clinmesh/contracts/pathology'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  getAdministratorPathologyAsset,
  getAdministratorPathologyAssetTile,
  getAdministratorPathologyPreparation,
  getPathologyCoverage,
  newIdempotencyKey,
  preparePathologyCases,
} from './api-client.ts'
import { ImagingViewer, type ImagingViewerSource } from './imaging/imaging-viewer.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

const examLabels: Record<PathologyExamCode, [string, string]> = {
  'breast-slide-consultation': ['乳腺切片病理会诊', 'Breast slide consultation'],
}

const reasonLabels: Record<PathologyPreparationReason, [string, string]> = {
  ASSET_NOT_INSTALLED: ['相符切片尚未安装', 'The compatible slide is not installed'],
  ASSET_NOT_PUBLISHED: ['没有通过复核的切片素材', 'No slide asset has been reviewed'],
  FACT_UNKNOWN: ['来源或素材缺少受体、淋巴结或 T 分期，无法确认相容', 'A receptor, node or T fact is missing, so compatibility cannot be confirmed'],
  FIXED_FACT_CONFLICT: ['病例既有事实与全部切片素材矛盾', 'Existing case facts contradict every slide asset'],
  NO_APPLICABLE_RULE: ['来源没有可用依据', 'The source gives no applicable basis'],
  NO_SOURCE_PROCEDURE: ['既往病史中没有可送检的手术', 'The history has no source procedure to consult on'],
}

const factLabels: Record<PathologyFactName, [string, string]> = {
  'estrogen-receptor': ['ER', 'ER'],
  'her2': ['HER2', 'HER2'],
  'lymph-nodes': ['淋巴结', 'Lymph nodes'],
  'progesterone-receptor': ['PR', 'PR'],
  'tumor-category': ['T 类别', 'T category'],
}
const factOrder: PathologyFactName[] = ['estrogen-receptor', 'progesterone-receptor', 'her2', 'lymph-nodes', 'tumor-category']

const blockerLabels: Record<string, [string, string]> = {
  ASSET_UNRECORDED: ['切片尚未登记', 'the slide is not recorded'],
  AUTOMATED_CHECK_FAILED: ['自动一致性检查未通过', 'the automated check failed'],
  REPORT_MISSING: ['没有报告', 'no report'],
  REVIEW_INCOMPLETE: ['复核项不完整', 'the review is incomplete'],
  REVIEW_MISSING: ['尚未复核', 'not reviewed'],
  REVIEW_NOT_APPROVED: ['复核未通过', 'the review was not approved'],
  REVIEW_STALE: ['复核后内容有改动', 'content changed after review'],
}

const pathologyKey = ['administrator-pathology']
const preparationKey = (caseId: string) => [...pathologyKey, 'preparation', caseId]
const coverageKey = [...pathologyKey, 'coverage']

function factValue(value: PathologyFactValue, zh: boolean): string {
  return value === 'positive' ? (zh ? '阳性' : 'positive') : value === 'negative' ? (zh ? '阴性' : 'negative') : value
}

function ExamPreparation({ exam, zh }: { exam: PathologyExamPreparation; zh: boolean }) {
  const pick = (labels: [string, string]) => labels[zh ? 0 : 1]
  return (
    <li className="border-t py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <strong className="font-medium">{pick(examLabels[exam.examCode])}</strong>
        <Badge variant={exam.status === 'ready' ? 'success' : exam.status === 'conflict' ? 'destructive' : 'warning'}>
          {exam.status === 'ready' ? (zh ? '已就绪' : 'Ready') : exam.status === 'conflict' ? (zh ? '待处理' : 'Conflict') : (zh ? '未覆盖' : 'Unsupported')}
        </Badge>
        {exam.reason === undefined ? null : <span className="text-muted-foreground">{pick(reasonLabels[exam.reason])}</span>}
      </div>
      {exam.evidence.conditions.map(condition => (
        <p className="mt-1 text-xs text-muted-foreground" key={condition.sourceReference}>
          {zh ? '来源诊断：' : 'Source diagnosis: '}{condition.display ?? condition.code}{zh ? `（${condition.code}）` : ` (${condition.code})`}
        </p>
      ))}
      {exam.evidence.facts.length === 0 ? null : (
        <p className="mt-1 text-xs text-muted-foreground">
          {zh ? '来源固定事实：' : 'Fixed source facts: '}
          {exam.evidence.facts.map(fact => `${pick(factLabels[fact.fact])} ${factValue(fact.value, zh)}`).join(' · ')}
        </p>
      )}
      {exam.sourceProcedures.map(procedure => (
        <div className="mt-2 text-xs text-muted-foreground" key={procedure.sourceReference}>
          <p>
            {zh ? '可送检手术：' : 'Source procedure: '}{procedure.display ?? procedure.code}{zh ? `（${procedure.code}）` : ` (${procedure.code})`}
            {' · '}{procedure.performedAt.slice(0, 10)}
          </p>
          {procedure.assetId === undefined ? null : (
            <p className="mt-1 break-all">
              <span className="font-mono">{procedure.assetId}</span>
              {' · '}{zh ? `报告修订 ${procedure.reportRevision}` : `report revision ${procedure.reportRevision}`}
              {procedure.supplements.map(supplement => ` · ${zh ? '素材补充的组织学类型：' : 'histologic type from the asset: '}${supplement.value}`).join('')}
            </p>
          )}
        </div>
      ))}
    </li>
  )
}

/** 管理员核对一个病例的病理准备结果；展开时才读取，可按当前清单重新准备。 */
export function PatientPathologyPreparation({ caseId, locale }: { caseId: string; locale: WorkspaceLocale }) {
  const [open, setOpen] = useState(false)
  const zh = locale === 'zh-CN'
  const queryClient = useQueryClient()
  const preparation = useQuery({
    enabled: open,
    gcTime: 0,
    queryFn: ({ signal }) => getAdministratorPathologyPreparation(caseId, signal),
    queryKey: preparationKey(caseId),
  })
  const prepare = useMutation({
    mutationFn: () => preparePathologyCases([caseId], newIdempotencyKey()),
    onSuccess: async (response) => {
      const prepared = response.data.prepared.find(item => item.caseId === caseId)
      if (prepared !== undefined) queryClient.setQueryData(preparationKey(caseId), prepared)
      await queryClient.invalidateQueries({ queryKey: coverageKey })
    },
  })
  return (
    <details className="border-t p-4" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }} open={open}>
      <summary className="cursor-pointer text-sm font-semibold">{zh ? '病理准备' : 'Pathology preparation'}</summary>
      {open ? (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">{zh ? '仅管理员可见，用于核对本病例可送检的既往手术、所配切片素材及其依据。' : 'Administrator view of the source procedures, slide assets and evidence for this case.'}</p>
          {preparation.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : preparation.isError ? (
            <Alert className="mt-3" variant="destructive">
              <AlertTitle>{zh ? '无法加载病理准备结果' : 'Unable to load pathology preparation'}</AlertTitle>
              <AlertDescription><Button onClick={() => void preparation.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button></AlertDescription>
            </Alert>
          ) : (
            <div className="mt-3">
              {preparation.data.preparation === null
                ? <p className="text-sm text-muted-foreground">{zh ? '尚未准备。' : 'Not prepared yet.'}</p>
                : (
                    <>
                      <p className="text-xs text-muted-foreground">
                        {zh ? `准备修订 ${preparation.data.preparation.revision}` : `Preparation revision ${preparation.data.preparation.revision}`}
                        {' · '}
                        {preparation.data.started
                          ? (zh ? '病例已开始，已绑定的切片不再替换' : 'The case has started; bound slides are no longer replaced')
                          : (zh ? '病例尚未开始，切片跟随最新一次准备' : 'The case has not started; slides follow the latest preparation')}
                      </p>
                      <ul className="mt-2">
                        {preparation.data.preparation.exams.map(exam => <ExamPreparation exam={exam} key={exam.examCode} zh={zh} />)}
                      </ul>
                    </>
                  )}
              {prepare.isError ? (
                <Alert className="mt-3" variant="destructive">
                  <AlertTitle>{zh ? '病理准备失败' : 'Pathology preparation failed'}</AlertTitle>
                  <AlertDescription>{getWorkspaceErrorMessage(prepare.error, getWorkspaceMessages(locale))}</AlertDescription>
                </Alert>
              ) : null}
              <Button className="mt-3" disabled={prepare.isPending} onClick={() => prepare.mutate()} size="sm" variant="outline">
                {zh ? '按当前清单重新准备' : 'Prepare with the current catalog'}
              </Button>
            </div>
          )}
        </div>
      ) : null}
    </details>
  )
}

/**
 * 管理员复核一份切片素材：直接阅片，并对照来源临床字段、报告草稿、自动检查结果与发布状态。
 * 复核结论由维护者用 `pnpm pathology:review` 签署到素材清单，这里不提供写入。
 */
function PathologyAssetReview({ assetId, locale }: { assetId: string; locale: WorkspaceLocale }) {
  const zh = locale === 'zh-CN'
  const asset = useQuery({
    gcTime: 0,
    queryFn: ({ signal }) => getAdministratorPathologyAsset(assetId, signal),
    queryKey: [...pathologyKey, 'asset', assetId],
  })
  const source = useMemo<ImagingViewerSource | undefined>(() => asset.data === undefined
    ? undefined
    : {
        loadBlock: (path, signal) => getAdministratorPathologyAssetTile(assetId, path, signal),
        study: asset.data.study,
      }, [asset.data, assetId])
  if (asset.isPending) return <Skeleton className="mt-2 h-40 w-full" />
  if (asset.isError || source === undefined) {
    return (
      <Alert className="mt-2" variant="destructive">
        <AlertTitle>{zh ? '无法加载素材' : 'Unable to load the asset'}</AlertTitle>
        <AlertDescription><Button onClick={() => void asset.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button></AlertDescription>
      </Alert>
    )
  }
  return (
    <div className="mt-2 grid gap-3">
      <ImagingViewer key={assetId} locale={locale} source={source} />
      {asset.data.reports.map(report => (
        <div className="text-sm" key={report.revision}>
          <p className="text-xs text-muted-foreground">{zh ? `报告修订 ${report.revision}` : `Report revision ${report.revision}`}</p>
          <p>{zh ? '镜下所见：' : 'Microscopy: '}{report.microscopy}</p>
          <p>{zh ? '病理诊断：' : 'Diagnosis: '}{report.diagnosis}</p>
          <p>{zh ? '既有免疫组化：' : 'Prior immunohistochemistry: '}{report.immunohistochemistry}</p>
          <p>{zh ? '备注：' : 'Note: '}{report.note}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {report.checkIssues.length === 0
              ? (zh ? '自动一致性检查通过' : 'Automated consistency check passed')
              : `${zh ? '自动一致性检查未通过：' : 'Automated check failed: '}${report.checkIssues.map(issue => issue.code).join(zh ? '、' : ', ')}`}
            {' · '}
            {asset.data.publication.publishedRevisions.includes(report.revision)
              ? (zh ? '已复核发布' : 'Reviewed and published')
              : (zh ? '尚未发布' : 'Not published')}
          </p>
        </div>
      ))}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">{zh ? '来源临床字段' : 'Source clinical fields'}</summary>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(asset.data.clinical, null, 2)}</pre>
      </details>
      <p className="break-all text-xs text-muted-foreground">
        {zh ? '核对无误后由维护者签署：' : 'After checking, the maintainer signs with: '}
        <code>pnpm pathology:review --asset {assetId} --reviewer &lt;{zh ? '复核人' : 'reviewer'}&gt; --pathologist no --conclusion approved</code>
      </p>
    </div>
  )
}

type CoverageAsset = PathologyCoverage['profiles'][number]['assets'][number]

/** 管理员覆盖清单：由素材派生的适配条目、素材状态、缺少字段的素材和当前患者库的准备结果；可批量准备。 */
export function PathologyCoveragePanel({ locale }: { locale: WorkspaceLocale }) {
  const [open, setOpen] = useState(false)
  const [reviewing, setReviewing] = useState<string>()
  const zh = locale === 'zh-CN'
  const pick = (labels: [string, string]) => labels[zh ? 0 : 1]
  const queryClient = useQueryClient()
  const coverage = useQuery({
    enabled: open,
    gcTime: 0,
    queryFn: ({ signal }) => getPathologyCoverage(signal),
    queryKey: coverageKey,
  })
  const prepare = useMutation({
    mutationFn: () => preparePathologyCases(undefined, newIdempotencyKey()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: pathologyKey }),
  })
  const assetLine = (asset: CoverageAsset) => (
    <div key={asset.assetId}>
      <p className="mt-1 break-all text-xs text-muted-foreground">
        <span className="font-mono">{asset.assetId}</span>
        {' · '}
        {asset.published
          ? (zh ? '已发布' : 'Published')
          : `${zh ? '未发布：' : 'Unpublished: '}${asset.blockers.map(code => pick(blockerLabels[code] ?? [code, code])).join(zh ? '、' : ', ')}`}
        {' · '}
        {asset.installed ? (zh ? '已安装' : 'Installed') : (zh ? '未安装' : 'Not installed')}
        {' '}
        <Button onClick={() => setReviewing(current => current === asset.assetId ? undefined : asset.assetId)} size="xs" variant="outline">
          {reviewing === asset.assetId ? (zh ? '收起' : 'Hide') : (zh ? '复核预览' : 'Review')}
        </Button>
      </p>
      {reviewing === asset.assetId ? <PathologyAssetReview assetId={asset.assetId} locale={locale} /> : null}
    </div>
  )
  return (
    <details className="border p-4" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }} open={open}>
      <summary className="cursor-pointer text-sm font-semibold">{zh ? '病理覆盖清单' : 'Pathology coverage'}</summary>
      {open ? (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">{zh ? '仅管理员可见。切片只配给受体、淋巴结与 T 类别全部相符的病例；适配条目由素材的临床字段派生。' : 'Administrator only. Slides are assigned only to cases whose receptor, node and T facts all agree.'}</p>
          {coverage.isPending ? <Skeleton className="mt-3 h-32 w-full" /> : coverage.isError ? (
            <Alert className="mt-3" variant="destructive">
              <AlertTitle>{zh ? '无法加载病理覆盖清单' : 'Unable to load pathology coverage'}</AlertTitle>
              <AlertDescription>{getWorkspaceErrorMessage(coverage.error, getWorkspaceMessages(locale))} <Button onClick={() => void coverage.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button></AlertDescription>
            </Alert>
          ) : coverage.data.catalog === null ? (
            <p className="mt-3 text-sm text-muted-foreground">{zh ? '没有可用的病理素材清单或适配规则。' : 'No pathology asset catalog or matching rules are available.'}</p>
          ) : (
            <div className="mt-3 grid gap-4">
              <section>
                <h4 className="text-sm font-semibold">{zh ? '适配条目' : 'Matching profiles'}</h4>
                <ul>
                  {coverage.data.profiles.map(profile => (
                    <li className="border-t py-2 text-sm" key={profile.id}>
                      <span>{profile.label}</span>
                      {profile.assets.map(assetLine)}
                    </li>
                  ))}
                </ul>
              </section>
              {coverage.data.gaps.length === 0 ? null : (
                <section>
                  <h4 className="text-sm font-semibold">{zh ? '缺少匹配字段的素材' : 'Assets lacking matching facts'}</h4>
                  <ul>
                    {coverage.data.gaps.map(gap => (
                      <li className="border-t py-2 text-sm" key={gap.assetId}>
                        <span>{zh ? '缺少：' : 'Missing: '}{factOrder.filter(name => gap.missing.includes(name)).map(name => pick(factLabels[name])).join(zh ? '、' : ', ')}</span>
                        {assetLine(gap)}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {coverage.data.cases.exams.map((results) => {
                const unsupported = results.unsupported.reduce((sum, item) => sum + item.count, 0)
                return (
                  <p className="text-xs text-muted-foreground" key={results.examCode}>
                    {pick(examLabels[results.examCode])}{zh ? '：' : ': '}
                    {zh
                      ? `已就绪 ${results.ready} · 待处理 ${results.conflict} · 未覆盖 ${unsupported}`
                      : `Ready ${results.ready} · Conflict ${results.conflict} · Unsupported ${unsupported}`}
                    {results.unsupported.map(item => `（${pick(reasonLabels[item.reason])} ${item.count}）`).join('')}
                  </p>
                )
              })}
              <div className="flex flex-wrap items-center gap-3 border-t pt-3">
                <span className="text-sm">{zh ? `已准备 ${coverage.data.cases.prepared} / ${coverage.data.cases.total} 例` : `Prepared ${coverage.data.cases.prepared} / ${coverage.data.cases.total} cases`}</span>
                <Button disabled={prepare.isPending} onClick={() => prepare.mutate()} size="sm" variant="outline">
                  {zh ? '准备下一批病例' : 'Prepare the next batch'}
                </Button>
                {prepare.data === undefined ? null : (
                  <span className="text-xs text-muted-foreground">
                    {zh
                      ? `本批准备 ${prepare.data.data.prepared.length} 例，还有 ${prepare.data.data.remaining} 例待准备`
                      : `Prepared ${prepare.data.data.prepared.length} cases; ${prepare.data.data.remaining} remaining`}
                  </span>
                )}
              </div>
              {prepare.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>{zh ? '病理准备失败' : 'Pathology preparation failed'}</AlertTitle>
                  <AlertDescription>{getWorkspaceErrorMessage(prepare.error, getWorkspaceMessages(locale))}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </details>
  )
}
