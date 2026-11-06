import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import type { inpatientCatalogSchema } from '@clinmesh/contracts/inpatient'
import { Badge } from '@clinmesh/ui/components/badge'
import { cn } from '@clinmesh/ui/lib/utils'
import type { z } from 'zod'
import { inpatientCareDay } from './inpatient-scope.ts'
import { inpatientStatus } from './inpatient-patient-workspace.tsx'
import { InpatientFundingBadge } from './inpatient-funding-badge.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

/** 医生站左栏患者列表：姓名、病区/床位、住院天数与状态 chip，点击就地切换当前查看的住院。 */
export function InpatientDoctorPatientList({ admissions, viewedId, catalog, virtualTime, locale, onSelect }: {
  admissions: readonly InpatientAdmission[]
  viewedId: string
  catalog: z.infer<typeof inpatientCatalogSchema> | undefined
  virtualTime: string | undefined
  locale: WorkspaceLocale
  onSelect: (admissionId: string) => void
}): React.JSX.Element {
  const zh = locale === 'zh-CN', t = (cn: string, en: string) => zh ? cn : en
  const stageHint = (item: InpatientAdmission): string | undefined => {
    if (item.recordStatus === 'archived') return undefined
    if (item.status === 'registered') return t('等病区护士分床', 'Awaiting ward nurse bed assignment')
    if (item.recordStatus === 'reviewed') return t('等病案人员归档', 'Waiting for medical records to archive')
    if (item.financialStatus === 'settled' && item.recordStatus === 'open') return t('等你提交病案首页', 'Your turn: submit medical record')
    if (item.status === 'departed' && item.financialStatus === 'open') return t('等收费员结算', 'Awaiting cashier settlement')
    return undefined
  }
  return <div className="flex flex-col">
    <span aria-label={t('在册人数', 'Admission count')} className="sr-only">{t('在册 ', 'Admissions ')}{admissions.length}</span>
    <ul data-inpatient-queue-items className="flex flex-col gap-1.5">
      {admissions.map(item => {
        const current = item.id === viewedId
        const ward = catalog?.wards.find(entry => entry.id === item.wardId)?.name
        const bed = catalog?.beds.find(entry => entry.id === (item.bedId ?? item.lastBedId))?.name
        const day = inpatientCareDay(item, virtualTime)
        const fixedStay = item.departedAt !== undefined || item.status === 'departed' || item.status === 'cleared' || item.recordStatus === 'archived'
        const hint = stageHint(item)
        const statusVariant = item.recordStatus === 'archived' || item.status === 'cleared' ? 'outline'
          : item.status === 'admitted' ? 'info'
          : item.financialStatus === 'settled' ? 'secondary' : 'outline'
        const statusText = item.recordStatus === 'archived' ? t('已归档', 'Archived')
          : item.status === 'cleared' ? t('已清床', 'Bed cleared')
          : item.financialStatus === 'settled' ? t('已结算', 'Settled')
          : inpatientStatus(item, locale)
        return <li key={item.id}>
          <button type="button" aria-current={current ? 'true' : undefined} aria-label={`${t('查看', 'View ')}${item.patientName}`} onClick={() => onSelect(item.id)}
            className={cn('flex w-full flex-col gap-1 rounded-lg border px-2.5 py-2 text-start outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring', current ? 'border-info/55 bg-accent' : 'border-border/80 bg-card hover:bg-accent/60')}>
            <span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
              <span className="font-semibold">{item.patientName}</span>
              <span className="inline-flex flex-wrap items-center gap-1">
                <Badge variant={statusVariant}>{statusText}</Badge>
                <span className="sr-only"><InpatientFundingBadge outstandingFen={item.outstandingFen} locale={locale} compact /></span>
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {item.status === 'registered'
                ? (hint ?? t('等病区护士分床', 'Awaiting ward nurse bed assignment'))
                : <>
                    {bed ?? ward ?? '—'}
                    {day !== undefined ? <span> · {fixedStay ? <>{t('住院 ', '')}<span className="font-mono tabular-nums">{day}</span>{t(' 天', 'd stay')}</> : <>{t('第 ', 'day ')}<span className="font-mono tabular-nums">{day}</span>{t(' 天', '')}</>}</span> : null}
                    {hint ? ` · ${hint}` : ''}
                  </>}
            </span>
          </button>
        </li>
      })}
    </ul>
    {admissions.length === 0 ? <p className="px-3 py-2 text-sm text-muted-foreground">{t('暂无住院患者', 'No admissions')}</p> : null}
  </div>
}
