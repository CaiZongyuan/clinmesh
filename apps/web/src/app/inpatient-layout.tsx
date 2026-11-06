import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Badge } from '@clinmesh/ui/components/badge'
import { WorkspaceHeaderPatient, WorkspaceTabs, type WorkspaceTabItem } from './workspace-card-layout.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

/** 七岗位共用两行患者上下文；窄 DTO 只传入实际可读的事实。 */
export function InpatientPatientHeader({ name, identity, status, statusVariant = 'outline', location, details, amount, children }: {
  name: string
  identity?: ReactNode
  status?: ReactNode
  statusVariant?: 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'info' | 'outline'
  location?: ReactNode
  details?: ReactNode
  amount?: ReactNode
  children?: ReactNode
}) {
  return <><WorkspaceHeaderPatient>{name}</WorkspaceHeaderPatient><div className="clinmesh-inpatient-head">
    <div className="clinmesh-inpatient-head-main"><h2>{name}</h2>{identity ? <span className="text-sm text-muted-foreground">{identity}</span> : null}
      {status ? <Badge variant={statusVariant}>{status}</Badge> : null}{location ? <span className="text-sm text-muted-foreground">{location}</span> : null}
      {amount ? <div className="clinmesh-inpatient-head-amount">{amount}</div> : null}
    </div>
    {details ? <div className="clinmesh-inpatient-head-details">{details}</div> : null}
    {children}
  </div></>
}

export function InpatientTabs(props: { id: string; items: readonly WorkspaceTabItem[]; value: string; onValueChange(value: string): void; locale: WorkspaceLocale; children: ReactNode }) {
  return <WorkspaceTabs {...props} items={props.items.map(({ group: _group, ...item }) => item)} />
}

/** 环节首行紧接平铺页签，表单与清单不再嵌套另一张卡。 */
export function InpatientStageCard({ title, turn, owners, children }: { title: ReactNode; turn: ReactNode; owners?: ReactNode; children: ReactNode }) {
  const isMine = typeof turn === 'string' && (turn.startsWith('轮到你') || turn.startsWith('Your turn'))
  return <section className="clinmesh-inpatient-stage"><h2 aria-hidden="true" className="sr-only">{title}</h2>
    <div className="clinmesh-inpatient-turn"><p data-turn-mine={isMine || undefined}>{turn}<span data-slot="inpatient-turn-extra" /></p>{owners}</div>
    <div className="clinmesh-inpatient-stage-body">{children}</div>
  </section>
}

export function InpatientQueueGroup({ title, count, children }: { title: string; count: number | null; children: ReactNode }) {
  return <section aria-label={title} className="clinmesh-inpatient-queue-group"><h3><span>{title}</span>{count === null ? null : <span className="tabular-nums">{count}</span>}</h3>{children}</section>
}

/** 药嘱、执行和检查共用名称、元数据、状态与操作的位置。 */
export function InpatientItemRow({ title, badge, metadata, actions, complete, children }: {
  title: ReactNode; badge?: ReactNode; metadata?: ReactNode; actions?: ReactNode; complete?: boolean; children?: ReactNode
}) {
  const previous = useRef(complete)
  const [recent, setRecent] = useState(false)
  useEffect(() => {
    const justCompleted = complete && !previous.current
    previous.current = complete
    if (!justCompleted) return
    setRecent(true)
    const timeout = setTimeout(() => setRecent(false), 1200)
    return () => clearTimeout(timeout)
  }, [complete])
  return <article className="clinmesh-inpatient-item" data-complete={recent || undefined}>
    <div className="clinmesh-inpatient-item-info"><div className="clinmesh-inpatient-item-title">{title}{badge}</div>
      {metadata ? <div className="clinmesh-inpatient-item-meta">{metadata}</div> : null}</div>
    {actions ? <div className="clinmesh-inpatient-item-actions">{actions}</div> : null}
    {children ? <div className="clinmesh-inpatient-item-details">{children}</div> : null}
  </article>
}
