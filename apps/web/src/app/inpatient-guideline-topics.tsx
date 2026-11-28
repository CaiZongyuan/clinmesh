import {
  guidelineTopicBundleSchema,
  guidelineTopicIds,
  type GuidelineTopicId,
  type GuidelineTopicRead,
} from '@clinmesh/contracts/guideline-topics'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { useQuery } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { apiGet } from './api-client.ts'
import { inpatientScopeKey } from './inpatient-scope.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages, type WorkspaceLocale } from './workspace-i18n.ts'
import { WorkspaceSelect } from './workspace-select.tsx'

export const guidelineTopicOptionLabels: Record<GuidelineTopicId, readonly [string, string]> = {
  'contrast-kidney-hydration': ['对比剂肾损伤预防与围术期水化', 'Contrast kidney protection & hydration'],
  'coronary-revascularization-indication': ['冠脉血运重建指征与 FFR 功能学评估', 'Coronary revascularization & FFR'],
  'cad-dapt-and-secondary-prevention': ['双联抗血小板与冠心病二级预防', 'DAPT & secondary prevention'],
  'acute-chest-pain-acs': ['急性胸痛与 ACS 危险分层', 'Acute chest pain & ACS risk'],
  'pci-stent': ['冠脉介入支架选型与腔内影像', 'PCI stent category & imaging'],
  't2dm-renal-medication': ['2 型糖尿病合并慢性肾脏病用药', 'T2DM & CKD medication'],
}

const orderedPickerTopics = Object.keys(guidelineTopicOptionLabels) as GuidelineTopicId[]

function ErrAlert({ title, desc }: { title: string; desc: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{desc}</AlertDescription>
    </Alert>
  )
}

function BulletList({ items, cls = 'space-y-0.5 text-muted-foreground', label }: { items: readonly string[]; cls?: string; label?: string }) {
  return <ul aria-label={label} className={`list-disc pl-4 ${cls}`}>{items.map(item => <li key={item}>{item}</li>)}</ul>
}

export function InpatientGuidelineTopicsPanel({
  admission,
  session,
  locale,
  active = true,
  initialTopicId = 'contrast-kidney-hydration',
}: {
  admission: InpatientAdmission
  session: SessionContext
  locale: WorkspaceLocale
  active?: boolean | undefined
  initialTopicId?: GuidelineTopicId | undefined
}): React.JSX.Element | null {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  const pickerId = useId()
  const [selectedTopic, setSelectedTopic] = useState<GuidelineTopicId>(initialTopicId)
  const basePath = `/api/his/v1/inpatient/admissions/${admission.id}`
  const baseKey = [...inpatientScopeKey(session), admission.id]
  const topicReadQuery = useQuery({
    queryKey: [...baseKey, 'guideline-topics', selectedTopic],
    queryFn: ({ signal }) => apiGet(`${basePath}/guideline-topics?topicId=${encodeURIComponent(selectedTopic)}`, guidelineTopicBundleSchema, signal),
    enabled: active,
    retry: false,
  })
  if (!active) return null
  const topicRead = topicReadQuery.error === null
    ? topicReadQuery.data?.items.find(item => item.topic.id === selectedTopic)
    : undefined

  return (
    <section aria-label={t('指南参考意见', 'Guideline reference topics')} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="font-medium">{t('循证指南专题', 'Clinical guideline topics')}</h4>
        <Button
          variant="outline"
          size="sm"
          disabled={topicReadQuery.isFetching}
          onClick={() => { void topicReadQuery.refetch() }}
        >
          {t('刷新指南状态', 'Refresh guideline status')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="font-medium" htmlFor={`${pickerId}-topic-select`}>
          {t('指南专题', 'Guideline topic')}
        </label>
        <div className="w-72 max-w-full">
          <WorkspaceSelect
            id={`${pickerId}-topic-select`}
            ariaLabel={t('指南专题', 'Guideline topic')}
            value={selectedTopic}
            items={orderedPickerTopics.map(topicId => ({
              value: topicId,
              label: guidelineTopicOptionLabels[topicId][locale === 'zh-CN' ? 0 : 1],
            }))}
            onValueChange={value => {
              if (value && (guidelineTopicIds as readonly string[]).includes(value)) {
                setSelectedTopic(value as GuidelineTopicId)
              }
            }}
          />
        </div>
      </div>
      <SynchronousGuidelineTopicCard
        error={topicReadQuery.error}
        loading={topicReadQuery.isPending}
        locale={locale}
        read={topicRead}
      />
    </section>
  )
}

export function SynchronousGuidelineTopicCard({
  error,
  loading,
  locale,
  read,
}: {
  error: Error | null | undefined
  loading: boolean
  locale: WorkspaceLocale
  read: GuidelineTopicRead | undefined
}): React.JSX.Element | null {
  const t = (cn: string, en: string) => locale === 'zh-CN' ? cn : en
  if (loading) {
    return (
      <div role="status" className="text-xs text-muted-foreground">
        {t('正在读取同步专题依据…', 'Loading synchronous guideline topic passages…')}
      </div>
    )
  }
  if (error) return <ErrAlert title={t('同步专题依据读取失败', 'Could not read synchronous guideline passages')} desc={getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))} />
  if (!read) return null

  return (
    <div aria-label={t('同步原文与客观指标核对', 'Synchronous guideline passages & patient indicators')} className="flex min-w-0 flex-col gap-2 rounded-md border bg-muted/20 p-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{locale === 'zh-CN' ? read.topic.titleZh : read.topic.titleEn}</span>
        <Badge variant={read.status === 'available' ? 'secondary' : 'outline'}>
          {read.status === 'available'
            ? t('原文已核验 · 零AI调用', 'Verified passages · 0 AI calls')
            : t('原文暂不可用', 'Sources unavailable')}
        </Badge>
      </div>
      {read.status === 'unavailable' && read.degradedReason ? (
        <Alert>
          <AlertTitle>{t('本专题原文暂不可用', 'Topic sources unavailable')}</AlertTitle>
          <AlertDescription>{read.degradedReason}</AlertDescription>
        </Alert>
      ) : null}
      {read.patientIndicators.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-muted-foreground">{t('当前患者客观指标', 'Current patient indicators')}</span>
          <ul className="space-y-1">
            {read.patientIndicators.map(indicator => (
              <li key={indicator.code} className="flex flex-wrap items-center gap-1.5">
                <Badge variant={indicator.status === 'present' ? 'secondary' : 'outline'}>
                  {indicator.status === 'present' ? t('已记录', 'Present') : t('待补充', 'Missing')}
                </Badge>
                <span>{locale === 'zh-CN' ? indicator.labelZh : indicator.labelEn}</span>
                {indicator.valueText ? <span className="text-muted-foreground tabular-nums">· {indicator.valueText}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {read.missingPatientInputs.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="font-medium text-muted-foreground">{t('患者资料待补充项', 'Missing patient inputs')}</span>
          <BulletList items={read.missingPatientInputs} />
        </div>
      ) : null}
      {read.guidelines.length > 0 ? (
        <details>
          <summary className="cursor-pointer font-medium text-info">
            {t(`查看经核验指南原文段落 (${read.guidelines.length})`, `View verified guideline passages (${read.guidelines.length})`)}
          </summary>
          <div className="flex min-w-0 flex-col gap-2 pt-2">
            {read.guidelines.map(source => (
              <div key={source.id} className="flex min-w-0 flex-col gap-1 border-b pb-2 last:border-b-0">
                <p className="break-words font-medium">{source.title}</p>
                <p className="break-words text-muted-foreground">{source.version} · {source.locator} · {source.publisher}</p>
                <blockquote className="max-w-prose whitespace-pre-wrap break-words">{source.text}</blockquote>
              </div>
            ))}
          </div>
        </details>
      ) : null}
      <BulletList items={read.limitations} />
    </div>
  )
}
