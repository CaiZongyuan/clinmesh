import { cn } from '@clinmesh/ui/lib/utils'
import type { ReactNode } from 'react'

export function DoctorOrderWorkspace({ entry, pending, records, details, hasRecords }: {
  entry: ReactNode
  pending: ReactNode
  records?: ReactNode
  details?: ReactNode
  hasRecords: boolean
}) {
  return <div className="@container/order-workspace min-w-0" data-doctor-order-workspace="" data-has-records={hasRecords}>
    <div className={cn('grid min-w-0 gap-4', hasRecords
      ? '@min-[800px]/order-workspace:grid-cols-[minmax(0,7fr)_minmax(0,13fr)]'
      : '@min-[800px]/order-workspace:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]')}>
      {/* 用 contents 改变布局，保留开具前后编辑区与待办的组件身份。 */}
      <div className={hasRecords ? 'flex min-w-0 flex-col gap-4' : 'contents'}>
        <div className="min-w-0" data-order-entry="">{entry}</div>
        <div className="min-w-0" data-order-pending="">{pending}</div>
        {hasRecords ? <div className="min-w-0" data-order-records="">{records}</div> : null}
      </div>
      {hasRecords ? <div className="min-w-0" data-order-details="">{details}</div> : null}
    </div>
  </div>
}
