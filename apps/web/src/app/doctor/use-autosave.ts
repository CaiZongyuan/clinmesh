import { useEffect, useRef } from 'react'

export function useAutosave({
  delayMs = 500,
  enabled,
  onSave,
  revision,
}: {
  delayMs?: number
  enabled: boolean
  onSave: () => void
  revision: string
}): void {
  const onSaveRef = useRef(onSave)
  // The same content and owner version wait for a new edit or owner refresh after failure.
  const attemptedRevisionRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  useEffect(() => {
    if (!enabled || attemptedRevisionRef.current === revision) return
    const timeout = window.setTimeout(() => {
      attemptedRevisionRef.current = revision
      onSaveRef.current()
    }, delayMs)
    return () => window.clearTimeout(timeout)
  }, [delayMs, enabled, revision])
}
