import { useEffect, useRef } from 'react'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { InpatientDrgSimulationInput } from '@clinmesh/contracts/inpatient-drg-simulation'
import { OrderEstimate, useOrderEstimate } from './inpatient-order-estimate.tsx'
import { orderSelection, type OrderDraftRow } from './inpatient-order-drafts.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function InpatientOrderRowEstimate({ row, session, admissionId, locale, enabled, onUpdate, onReady }: {
  row: OrderDraftRow; session: SessionContext; admissionId: string; locale: WorkspaceLocale; enabled: boolean
  onUpdate(id: string, patch: Partial<OrderDraftRow>): boolean; onReady(id: string, fingerprint: string | undefined): void
}) {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const current = useRef({ generation: row.estimate?.generation, enabled })
  current.current = { generation: row.estimate?.generation, enabled }
  const generation = row.estimate?.generation
  const selection = orderSelection(row)
  const draft: InpatientDrgSimulationInput | undefined = selection?.kind === 'medication'
    ? { medications: [{ catalogItemId: selection.catalogItemId, catalogVersion: selection.catalogVersion, doseText: selection.doseText, doseQuantity: selection.doseQuantity, frequencyCode: selection.frequencyCode }], services: [] }
    : selection?.kind === 'service' ? { medications: [], services: [{ serviceId: selection.serviceId, serviceVersion: selection.serviceVersion, quantity: 1 }] } : undefined
  const estimate = useOrderEstimate({ scope: ['inpatient', session.actor.workspaceId, session.actor.epoch, session.actor.practitionerRoleId], admissionId, draft, enabled,
    review: row.estimate ?? { stale: false }, onReview: review => {
      if (mounted.current && current.current.enabled && generation && current.current.generation === generation) onUpdate(row.id, { estimate: { ...review, generation } })
    } })
  useEffect(() => { onReady(row.id, estimate.fingerprint); return () => onReady(row.id, undefined) }, [row.id, estimate.fingerprint, onReady])
  return <OrderEstimate estimate={estimate} locale={locale} />
}
