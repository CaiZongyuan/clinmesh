import { createContext, useContext, type ReactNode, type RefObject } from 'react'

export interface WebRuntimeOptions {
  apiBasePath?: string
}

export interface WebRuntimeValue {
  appearanceRoot: RefObject<HTMLElement | null>
  mode: 'standalone'
}

const WebRuntimeContext = createContext<WebRuntimeValue | null>(null)

export function WebRuntimeProvider({
  children,
  value,
}: {
  children: ReactNode
  value: WebRuntimeValue
}): React.JSX.Element {
  return <WebRuntimeContext.Provider value={value}>{children}</WebRuntimeContext.Provider>
}

export function useWebRuntime(): WebRuntimeValue {
  const value = useContext(WebRuntimeContext)
  if (value === null) throw new Error('useWebRuntime must be used inside WebRuntimeProvider')
  return value
}

/** Nullable variant for shared components that may render outside the provider. */
export function useOptionalWebRuntime(): WebRuntimeValue | null {
  return useContext(WebRuntimeContext)
}
