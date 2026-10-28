import type { InpatientAdmission } from '@clinmesh/contracts/inpatient'
import { Badge } from '@clinmesh/ui/components/badge'
import { formatFen } from './workspace-format.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function InpatientFundingBadge({ outstandingFen, locale, compact = false }: {
  outstandingFen: InpatientAdmission['outstandingFen']; locale: WorkspaceLocale; compact?: boolean
}): React.JSX.Element | null {
  const zh = locale === 'zh-CN'
  if (outstandingFen === null) return <Badge variant="outline">{zh ? '资金待确认' : 'Funding pending'}</Badge>
  if (outstandingFen === undefined || outstandingFen === 0) return null
  return <Badge variant="outline" className="text-destructive" title={`${zh ? '尚应收' : 'Outstanding'} ${formatFen(outstandingFen, locale)}`}>
    {zh ? compact ? '欠费' : '欠费预警' : 'Arrears'}
  </Badge>
}
