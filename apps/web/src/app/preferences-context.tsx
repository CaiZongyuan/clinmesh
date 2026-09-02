import {
  createContext,
  useContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react'
import type { WebPreferences } from './preferences.ts'

interface WebPreferencesContextValue {
  preferences: WebPreferences
  setPreferences: Dispatch<SetStateAction<WebPreferences>>
}

const WebPreferencesContext = createContext<WebPreferencesContextValue | null>(null)

export function WebPreferencesProvider({
  children,
  value,
}: {
  children: ReactNode
  value: WebPreferencesContextValue
}): React.JSX.Element {
  return <WebPreferencesContext.Provider value={value}>{children}</WebPreferencesContext.Provider>
}

export function useWebPreferences(): WebPreferencesContextValue {
  const value = useContext(WebPreferencesContext)
  if (value === null) throw new Error('useWebPreferences must be used inside WebPreferencesProvider')
  return value
}
