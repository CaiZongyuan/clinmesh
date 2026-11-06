import { cn } from '@clinmesh/ui/lib/utils'
import { createContext, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'

const OrderDetailsContext = createContext<{
  hasRecords: boolean
  pendingVisible: boolean
  setPendingVisible: Dispatch<SetStateAction<boolean>>
  host: HTMLDivElement | null
} | undefined>(undefined)

export const useOrderDetails = () => useContext(OrderDetailsContext)

export function DoctorOrderWorkspace({ entry, pending, records, details, hasRecords }: {
  entry: ReactNode
  pending: ReactNode
  records?: ReactNode
  details?: ReactNode
  hasRecords: boolean
}) {
  const [pendingVisible, setPendingVisible] = useState(false)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  return <OrderDetailsContext.Provider value={{ hasRecords, pendingVisible, setPendingVisible, host }}><div className="@container/order-workspace flex min-w-0 flex-col gap-3" data-doctor-order-workspace="" data-has-records={hasRecords}>
    <div className="empty:hidden min-w-0" data-order-entry="">{entry}</div>
    <div className="empty:hidden min-w-0" data-order-pending="">{pending}</div>
    {hasRecords ? (
      <div className={cn('grid min-w-0 gap-4', (details != null || pendingVisible) && '@min-[800px]/order-workspace:grid-cols-[minmax(0,7fr)_minmax(0,13fr)]')}>
        <div className="min-w-0" data-order-records="" onClickCapture={() => setPendingVisible(false)}>{records}</div>
        <div className={cn('min-w-0', details == null && !pendingVisible && 'hidden')} data-order-details="">
          {/* 隐藏而不卸载，保留待办中尚未保存的输入。 */}
          <div hidden={pendingVisible}>{details}</div>
          <div hidden={!pendingVisible} ref={setHost} />
        </div>
      </div>
    ) : null}
  </div></OrderDetailsContext.Provider>
}
