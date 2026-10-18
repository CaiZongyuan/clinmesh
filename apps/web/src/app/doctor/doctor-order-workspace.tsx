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
  return <OrderDetailsContext.Provider value={{ hasRecords, pendingVisible, setPendingVisible, host }}><div className="@container/order-workspace min-w-0" data-doctor-order-workspace="" data-has-records={hasRecords}>
    <div className={cn('grid min-w-0 gap-4', hasRecords
      ? '@min-[800px]/order-workspace:grid-cols-[minmax(0,7fr)_minmax(0,13fr)]'
      : '@min-[800px]/order-workspace:grid-cols-[minmax(0,7fr)_minmax(0,3fr)]')}>
      {/* 用 contents 改变布局，保留开具前后编辑区与待办的组件身份。 */}
      <div className={hasRecords ? 'flex min-w-0 flex-col gap-4' : 'contents'}>
        <div className="min-w-0" data-order-entry="">{entry}</div>
        <div className="min-w-0" data-order-pending="">{pending}</div>
        {hasRecords ? <div className="min-w-0" data-order-records="" onClickCapture={() => setPendingVisible(false)}>{records}</div> : null}
      </div>
      {hasRecords ? <div className="min-w-0" data-order-details="">
        {/* 隐藏而不卸载，保留待办中尚未保存的输入。 */}
        <div hidden={pendingVisible}>{details}</div>
        <div hidden={!pendingVisible} ref={setHost} />
      </div> : null}
    </div>
  </div></OrderDetailsContext.Provider>
}
