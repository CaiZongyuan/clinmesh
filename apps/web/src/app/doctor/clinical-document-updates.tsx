import type { ClinicalDocumentContent } from '@clinmesh/contracts/his'
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

type DocumentField = keyof ClinicalDocumentContent
type FieldUpdates = Partial<Record<DocumentField, number>>

export interface ClinicalDocumentUpdates {
  fields: FieldUpdates
  viewedMilliseconds: Map<number, number>
  onSeen: (field: DocumentField, revision: number) => void
}

// These baselines describe displayed text, including unsaved edits, rather than
// another copy of server state. A manual edit advances its baseline immediately.
export function useClinicalDocumentUpdates(caseId: string | undefined, document: ClinicalDocumentContent | undefined, editable: boolean) {
  const baselines = useRef<Record<string, ClinicalDocumentContent>>({})
  const revision = useRef(0)
  const viewedMilliseconds = useRef(new Map<number, number>())
  const [updates, setUpdates] = useState<Record<string, FieldUpdates>>({})
  useEffect(() => {
    const pending = new Set(Object.values(updates).flatMap(fields => Object.values(fields)))
    for (const key of viewedMilliseconds.current.keys()) {
      if (!pending.has(key)) viewedMilliseconds.current.delete(key)
    }
  }, [updates])
  useLayoutEffect(() => {
    if (caseId === undefined || document === undefined) return
    const previous = baselines.current[caseId]
    baselines.current[caseId] = document
    if (!editable) {
      setUpdates(current => current[caseId] === undefined ? current : { ...current, [caseId]: {} })
      return
    }
    if (previous === undefined) return
    const changed = (Object.keys({ ...previous, ...document }) as DocumentField[]).filter(field => (previous[field] ?? '') !== (document[field] ?? ''))
    if (changed.length === 0) return
    const changedRevisions = Object.fromEntries(changed.map(field => [field, ++revision.current]))
    setUpdates(current => ({ ...current, [caseId]: {
      ...current[caseId], ...changedRevisions,
    } }))
  }, [caseId, document, editable])

  const onEdit = useCallback((editedCaseId: string, next: ClinicalDocumentContent) => {
    const previous = baselines.current[editedCaseId]
    baselines.current[editedCaseId] = next
    const changed = (Object.keys({ ...previous, ...next }) as DocumentField[]).filter(field => (previous?.[field] ?? '') !== (next[field] ?? ''))
    setUpdates(current => {
      const fields = { ...current[editedCaseId] }
      for (const field of changed) delete fields[field]
      return { ...current, [editedCaseId]: fields }
    })
  }, [])
  const onSeen = useCallback((field: DocumentField, seenRevision: number) => {
    if (caseId === undefined) return
    setUpdates(current => {
      if (current[caseId]?.[field] !== seenRevision) return current
      const fields = { ...current[caseId] }
      delete fields[field]
      return { ...current, [caseId]: fields }
    })
  }, [caseId])
  return { fields: caseId === undefined || !editable ? {} : updates[caseId] ?? {},
    viewedMilliseconds: viewedMilliseconds.current, onEdit, onSeen }
}

export function ClinicalDocumentUpdateControl({ children, field, updates }: {
  children: ReactNode
  field: DocumentField
  updates: ClinicalDocumentUpdates | undefined
}): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'pending' | 'visible' | 'fading'>('pending')
  const revision = updates?.fields[field]
  const onSeen = updates?.onSeen
  const viewedMilliseconds = updates?.viewedMilliseconds
  useEffect(() => {
    const element = root.current
    if (revision === undefined || onSeen === undefined || viewedMilliseconds === undefined || element === null) return
    const owner = element.ownerDocument
    let inViewport = false
    let viewed = viewedMilliseconds.get(revision) ?? 0
    let visibleSince: number | undefined
    let fadeTimer: ReturnType<typeof setTimeout> | undefined
    let seenTimer: ReturnType<typeof setTimeout> | undefined
    const pause = () => {
      clearTimeout(fadeTimer)
      clearTimeout(seenTimer)
      if (visibleSince !== undefined) {
        viewed += performance.now() - visibleSince
        viewedMilliseconds.set(revision, viewed)
        visibleSince = undefined
      }
    }
    const observeVisibility = () => {
      pause()
      if (!inViewport || owner.hidden) { setPhase('pending'); return }
      visibleSince = performance.now()
      element.style.setProperty('--clinical-update-fade-duration', `${Math.min(800, Math.max(0, 4_800 - viewed))}ms`)
      setPhase(viewed < 4_000 ? 'visible' : 'fading')
      if (viewed < 4_000) fadeTimer = setTimeout(() => setPhase('fading'), 4_000 - viewed)
      seenTimer = setTimeout(() => {
        pause()
        viewedMilliseconds.delete(revision)
        onSeen(field, revision)
      }, Math.max(0, 4_800 - viewed))
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      inViewport = entries.some(entry => entry.isIntersecting)
      observeVisibility()
    })
    if (observer === undefined) { inViewport = true; observeVisibility() }
    else observer.observe(element)
    owner.addEventListener('visibilitychange', observeVisibility)
    return () => { pause(); observer?.disconnect(); owner.removeEventListener('visibilitychange', observeVisibility) }
  }, [field, revision, onSeen, viewedMilliseconds])
  return <div ref={root} className="clinical-document-update-control" data-clinical-document-update={revision === undefined ? undefined : phase}>
    {children}
    {revision === undefined ? null : <span className="clinical-document-update-flow" aria-hidden="true" />}
  </div>
}
