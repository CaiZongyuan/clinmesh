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
  return <div className="flex flex-col">
    <div className="flex items-baseline justify-between gap-2 border-b px-3 py-2">
      <h3 className="text-sm font-semibold">{t('住院患者', 'Inpatients')}</h3>
      <span aria-label={t('在册人数', 'Admission count')} className="font-mono text-xs text-muted-foreground">{admissions.length}</span>
    </div>
    <ul className="flex flex-col">
      {admissions.map(item => {
        const current = item.id === viewedId
        const ward = catalog?.wards.find(entry => entry.id === item.wardId)?.name
        const bed = catalog?.beds.find(entry => entry.id === item.bedId)?.name
        const day = inpatientCareDay(item, virtualTime)
        return <li key={item.id}>
          <button type="button" aria-current={current ? 'true' : undefined} onClick={() => onSelect(item.id)}
            className={cn('flex w-full flex-col gap-1 border-b px-3 py-2 text-start', current ? 'bg-accent' : 'hover:bg-accent/60')}>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium">{item.patientName}</span>
              <Badge variant="outline" className="text-muted-foreground">{inpatientStatus(item, locale)}</Badge>
              <InpatientFundingBadge outstandingFen={item.outstandingFen} locale={locale} compact />
            </span>
            <span className="text-xs text-muted-foreground">
              {ward ?? '—'}{bed !== undefined ? ` · ${bed}` : ''}
              {day !== undefined ? <span> · {t('第 ', 'day ')}<span className="font-mono">{day}</span>{t(' 天', '')}</span> : null}
            </span>
          </button>
        </li>
      })}
    </ul>
    {admissions.length === 0 ? <p className="px-3 py-2 text-sm text-muted-foreground">{t('暂无住院患者', 'No admissions')}</p> : null}
  </div>
}
