import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Button } from '@clinmesh/ui/components/button'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export function InpatientConfirmation({ title, description, confirmLabel, locale, children, pending, disabled, onCancel, onConfirm }: {
  title: string; description: string; confirmLabel: string; locale: WorkspaceLocale; children?: ReactNode
  pending: boolean | undefined; disabled: boolean | undefined; onCancel(): void; onConfirm(): void
}) {
  const confirm = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    let active = document.activeElement
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
    const previous = active instanceof HTMLElement ? active : null
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }) }
  }, [])
  useLayoutEffect(() => { if (!disabled) confirm.current?.focus() }, [disabled])
  return <section aria-label={title} className="flex min-w-0 flex-col gap-3 rounded-md border border-ring bg-card p-3" onKeyDown={event => {
    if (event.key === 'Escape' && !pending) { event.preventDefault(); event.stopPropagation(); onCancel() }
  }}>
    <h4 className="font-medium">{title}</h4>
    <p className="text-sm text-muted-foreground">{description}</p>
    {children}
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="outline" disabled={pending} onClick={onCancel}>{locale === 'zh-CN' ? '取消' : 'Cancel'}</Button>
      <Button ref={confirm} disabled={disabled} onClick={onConfirm}>{confirmLabel}</Button>
    </div>
  </section>
}
