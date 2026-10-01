import type {
  ImagingExamCode,
  ImagingExamPreparation,
  ImagingPreparationReason,
} from '@clinmesh/contracts/imaging'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  getAdministratorImagingAsset,
  getAdministratorImagingAssetBlock,
  getAdministratorImagingPreparation,
  getImagingCoverage,
  newIdempotencyKey,
  prepareImagingCases,
} from './api-client.ts'
import { ImagingViewer, type ImagingViewerSource } from './imaging/imaging-viewer.tsx'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'

const examLabels: Record<ImagingExamCode, [string, string]> = {
  'chest-ct-plain': ['胸部 CT 平扫', 'Chest CT (plain)'],
  'chest-radiograph': ['胸片', 'Chest radiograph'],
}

const reasonLabels: Record<ImagingPreparationReason, [string, string]> = {
  ASSET_NOT_PUBLISHED: ['素材尚未通过复核', 'The asset has not been reviewed'],
  FIXED_FACT_CONFLICT: ['病例既有事实与素材冲突', 'Existing case facts conflict with the asset'],
  NO_APPLICABLE_RULE: ['来源没有可用依据', 'The source gives no applicable basis'],
  NO_ASSET_FOR_DEMOGRAPHICS: ['没有与年龄、性别相符的素材', 'No asset fits the age and sex'],
  PROFILE_LACKS_EXAM: ['适配条目没有该检查的素材', 'The matching profile has no asset for this exam'],
  UNCOVERED_CONDITION: ['疾病在明确未覆盖清单中', 'The condition is explicitly uncovered'],
}

const blockerLabels: Record<string, [string, string]> = {
  ASSET_UNRECORDED: ['像素尚未登记', 'pixels are not recorded'],
  AUTOMATED_CHECK_FAILED: ['自动一致性检查未通过', 'the automated check failed'],
  REPORT_MISSING: ['没有报告', 'no report'],
  REVIEW_INCOMPLETE: ['复核项不完整', 'the review is incomplete'],
  REVIEW_MISSING: ['尚未复核', 'not reviewed'],
  REVIEW_NOT_APPROVED: ['复核未通过', 'the review was not approved'],
  REVIEW_STALE: ['复核后内容有改动', 'content changed after review'],
}

const imagingKey = ['administrator-imaging']
const preparationKey = (caseId: string) => [...imagingKey, 'preparation', caseId]
const coverageKey = [...imagingKey, 'coverage']

function ExamPreparation({ exam, zh }: { exam: ImagingExamPreparation; zh: boolean }) {
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
      {exam.assetId === undefined ? null : (
        <p className="mt-1 break-all font-mono text-xs text-muted-foreground">
          {exam.assetId} · {zh ? `报告修订 ${exam.reportRevision}` : `report revision ${exam.reportRevision}`}
        </p>
      )}
      {exam.evidence.facts.map(fact => (
        <p className="mt-1 text-xs text-muted-foreground" key={`${fact.scope}:${fact.sourceReference}`}>
          {fact.scope === 'index' ? (zh ? '本次病例' : 'Index case') : (zh ? '既往病史' : 'History')}
          {zh ? '：' : ': '}{fact.display ?? fact.code}{zh ? `（${fact.code}）` : ` (${fact.code})`}
        </p>
      ))}
      {exam.evidence.sourceExams.map(source => (
        <p className="mt-1 text-xs text-muted-foreground" key={source.sourceReference}>
          {zh ? '来源检查：' : 'Source exam: '}{source.display ?? source.code}{zh ? `（${source.code}）` : ` (${source.code})`}
        </p>
      ))}
    </li>
  )
}

/** 管理员核对一个病例的影像准备结果；展开时才读取，可按当前清单重新准备。 */
export function PatientImagingPreparation({ caseId, locale }: { caseId: string; locale: WorkspaceLocale }) {
  const [open, setOpen] = useState(false)
  const zh = locale === 'zh-CN'
  const queryClient = useQueryClient()
  const preparation = useQuery({
    enabled: open,
    gcTime: 0,
    queryFn: ({ signal }) => getAdministratorImagingPreparation(caseId, signal),
    queryKey: preparationKey(caseId),
  })
  const prepare = useMutation({
    mutationFn: () => prepareImagingCases([caseId], newIdempotencyKey()),
    onSuccess: async (response) => {
      const prepared = response.data.prepared.find(item => item.caseId === caseId)
      if (prepared !== undefined) queryClient.setQueryData(preparationKey(caseId), prepared)
      await queryClient.invalidateQueries({ queryKey: coverageKey })
    },
  })
  return (
    <details className="border-t p-4" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }} open={open}>
      <summary className="cursor-pointer text-sm font-semibold">{zh ? '影像准备' : 'Imaging preparation'}</summary>
      {open ? (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">{zh ? '仅管理员可见，用于核对本病例各项检查使用的影像素材及其依据。' : 'Administrator view of the imaging assets and evidence used for this case.'}</p>
          {preparation.isPending ? <Skeleton className="mt-3 h-24 w-full" /> : preparation.isError ? (
            <Alert className="mt-3" variant="destructive">
              <AlertTitle>{zh ? '无法加载影像准备结果' : 'Unable to load imaging preparation'}</AlertTitle>
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
                          ? (zh ? '病例已开始，已绑定的素材不再替换' : 'The case has started; bound assets are no longer replaced')
                          : (zh ? '病例尚未开始，素材跟随最新一次准备' : 'The case has not started; assets follow the latest preparation')}
                      </p>
                      <ul className="mt-2">
                        {preparation.data.preparation.exams.map(exam => <ExamPreparation exam={exam} key={exam.examCode} zh={zh} />)}
                      </ul>
                    </>
                  )}
              {prepare.isError ? (
                <Alert className="mt-3" variant="destructive">
                  <AlertTitle>{zh ? '影像准备失败' : 'Imaging preparation failed'}</AlertTitle>
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
 * 管理员复核一套素材：直接阅片，并对照来源标注、报告草稿、自动检查结果与发布状态。
 * 复核结论由维护者用 `pnpm imaging:review` 签署到素材清单，这里不提供写入。
 */
function ImagingAssetReview({ assetId, locale }: { assetId: string; locale: WorkspaceLocale }) {
  const zh = locale === 'zh-CN'
  const asset = useQuery({
    gcTime: 0,
    queryFn: ({ signal }) => getAdministratorImagingAsset(assetId, signal),
    queryKey: [...imagingKey, 'asset', assetId],
  })
  const source = useMemo<ImagingViewerSource | undefined>(() => asset.data === undefined
    ? undefined
    : {
        loadBlock: (path, signal) => getAdministratorImagingAssetBlock(assetId, path, signal),
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
          <p>{report.technique}</p>
          <p>{report.findings}</p>
          <p>{report.impression}</p>
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
        <summary className="cursor-pointer text-xs text-muted-foreground">{zh ? '来源标注' : 'Source annotation'}</summary>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(asset.data.annotation ?? null, null, 2)}</pre>
      </details>
      <p className="break-all text-xs text-muted-foreground">
        {zh ? '核对无误后由维护者签署：' : 'After checking, the maintainer signs with: '}
        <code>pnpm imaging:review --asset {assetId} --reviewer &lt;{zh ? '复核人' : 'reviewer'}&gt; --radiologist no --conclusion approved</code>
      </p>
    </div>
  )
}

/** 管理员覆盖清单：适配规则、素材状态、明确未覆盖的疾病和当前患者库的准备结果；可批量准备。 */
export function ImagingCoveragePanel({ locale }: { locale: WorkspaceLocale }) {
  const [open, setOpen] = useState(false)
  const [reviewing, setReviewing] = useState<string>()
  const zh = locale === 'zh-CN'
  const pick = (labels: [string, string]) => labels[zh ? 0 : 1]
  const queryClient = useQueryClient()
  const coverage = useQuery({
    enabled: open,
    gcTime: 0,
    queryFn: ({ signal }) => getImagingCoverage(signal),
    queryKey: coverageKey,
  })
  const prepare = useMutation({
    mutationFn: () => prepareImagingCases(undefined, newIdempotencyKey()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: imagingKey }),
  })
  return (
    <details className="border p-4" onToggle={event => { if (event.target === event.currentTarget) setOpen(event.currentTarget.open) }} open={open}>
      <summary className="cursor-pointer text-sm font-semibold">{zh ? '影像覆盖清单' : 'Imaging coverage'}</summary>
      {open ? (
        <div className="mt-3">
          <p className="text-xs text-muted-foreground">{zh ? '仅管理员可见。素材只配给有来源依据的病例；清单外的病例保留普通诊疗流程，但不保证影像闭环。' : 'Administrator only. Assets are assigned only to cases with source evidence.'}</p>
          {coverage.isPending ? <Skeleton className="mt-3 h-32 w-full" /> : coverage.isError ? (
            <Alert className="mt-3" variant="destructive">
              <AlertTitle>{zh ? '无法加载影像覆盖清单' : 'Unable to load imaging coverage'}</AlertTitle>
              <AlertDescription>{getWorkspaceErrorMessage(coverage.error, getWorkspaceMessages(locale))} <Button onClick={() => void coverage.refetch()} size="sm" variant="outline">{zh ? '重试' : 'Retry'}</Button></AlertDescription>
            </Alert>
          ) : coverage.data.catalog === null ? (
            <p className="mt-3 text-sm text-muted-foreground">{zh ? '没有可用的影像素材清单或适配规则。' : 'No imaging asset catalog or matching rules are available.'}</p>
          ) : (
            <div className="mt-3 grid gap-4">
              {coverage.data.exams.map((exam) => {
                const results = coverage.data.cases.exams.find(item => item.examCode === exam.examCode)
                const unsupported = results?.unsupported.reduce((sum, item) => sum + item.count, 0) ?? 0
                return (
                  <section key={exam.examCode}>
                    <h4 className="text-sm font-semibold">{pick(examLabels[exam.examCode])}</h4>
                    <ul>
                      {exam.profiles.map(profile => (
                        <li className="border-t py-2 text-sm" key={profile.id}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span>{profile.label}</span>
                            <Badge variant="outline">{profile.finding === 'positive' ? (zh ? '阳性' : 'Positive') : (zh ? '阴性' : 'Negative')}</Badge>
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {profile.sex === undefined ? (zh ? '不限性别' : 'Any sex') : profile.sex === 'male' ? (zh ? '男性' : 'Male') : (zh ? '女性' : 'Female')}
                            {' · '}{profile.ageRange[0]}–{profile.ageRange[1]} {zh ? '岁' : 'years'}
                            {' · '}{zh ? '来源编码' : 'Source codes'} {profile.conditionCodes.join('、')}
                          </p>
                          {profile.asset === null
                            ? <p className="mt-1 text-xs text-muted-foreground">{zh ? '没有该检查的素材' : 'No asset for this exam'}</p>
                            : (
                                <p className="mt-1 break-all text-xs text-muted-foreground">
                                  <span className="font-mono">{profile.asset.assetId}</span>
                                  {' · '}
                                  {profile.asset.published
                                    ? (zh ? '已发布' : 'Published')
                                    : `${zh ? '未发布：' : 'Unpublished: '}${profile.asset.blockers.map(code => pick(blockerLabels[code] ?? [code, code])).join(zh ? '、' : ', ')}`}
                                  {' · '}
                                  {profile.asset.installed ? (zh ? '已安装' : 'Installed') : (zh ? '未安装' : 'Not installed')}
                                  {' '}
                                  <Button
                                    onClick={() => setReviewing(current => current === profile.asset!.assetId ? undefined : profile.asset!.assetId)}
                                    size="xs"
                                    variant="outline"
                                  >
                                    {reviewing === profile.asset.assetId ? (zh ? '收起' : 'Hide') : (zh ? '复核预览' : 'Review')}
                                  </Button>
                                </p>
                              )}
                          {profile.asset !== null && reviewing === profile.asset.assetId
                            ? <ImagingAssetReview assetId={profile.asset.assetId} locale={locale} />
                            : null}
                        </li>
                      ))}
                    </ul>
                    {results === undefined ? null : (
                      <p className="mt-2 text-xs text-muted-foreground">
                        {zh
                          ? `已就绪 ${results.ready} · 待处理 ${results.conflict} · 未覆盖 ${unsupported}`
                          : `Ready ${results.ready} · Conflict ${results.conflict} · Unsupported ${unsupported}`}
                        {results.unsupported.map(item => `（${pick(reasonLabels[item.reason])} ${item.count}）`).join('')}
                      </p>
                    )}
                  </section>
                )
              })}
              <section>
                <h4 className="text-sm font-semibold">{zh ? '明确未覆盖的疾病' : 'Explicitly uncovered conditions'}</h4>
                <p className="mt-1 text-sm text-muted-foreground">
                  {coverage.data.uncovered.map(item => `${item.label}（${item.codes.join('、')}）`).join(zh ? '；' : '; ')}
                </p>
              </section>
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
                  <AlertTitle>{zh ? '影像准备失败' : 'Imaging preparation failed'}</AlertTitle>
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
