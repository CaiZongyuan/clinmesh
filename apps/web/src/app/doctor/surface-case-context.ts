import { useEffect } from 'react'
import { useOptionalWebRuntime, type WebSurfaceCaseContextState } from '../web-runtime.tsx'

/** surface 模式下把病例上下文快照发布到宿主右列;standalone、未接通 port 或无 runtime 时不发布。 */
export function useSurfaceCaseContextPort(state: WebSurfaceCaseContextState | undefined): void {
  const runtime = useOptionalWebRuntime()
  const mode = runtime?.mode
  const surfaceCaseContext = runtime?.surfaceCaseContext
  useEffect(() => {
    if (mode !== 'surface' || surfaceCaseContext === undefined || state === undefined) return
    return surfaceCaseContext.register(state)
  }, [mode, surfaceCaseContext, state])
}
