import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { createContext, useContext, type ReactNode } from 'react'
import { create } from 'zustand'
import type { WorkspaceLocale } from './workspace-i18n.ts'

type WorkspaceMode = 'outpatient' | 'inpatient'

interface WorkspaceModeState {
  modes: Record<string, WorkspaceMode>
  setMode(scope: string, mode: WorkspaceMode): void
}

const useWorkspaceModeStore = create<WorkspaceModeState>(set => ({
  modes: {},
  setMode: (scope, mode) => set(state => ({ modes: { ...state.modes, [scope]: mode } })),
}))

const WorkspaceModeContext = createContext<{
  locale: WorkspaceLocale
  mode: WorkspaceMode
  onChange(mode: WorkspaceMode): void
} | null>(null)

export function WorkspaceModeProvider({ children, locale, scope }: {
  children: (mode: WorkspaceMode) => ReactNode
  locale: WorkspaceLocale
  scope: string
}): React.JSX.Element {
  const mode = useWorkspaceModeStore(state => state.modes[scope] ?? 'outpatient')
  const setMode = useWorkspaceModeStore(state => state.setMode)
  return <WorkspaceModeContext.Provider value={{ locale, mode, onChange: value => setMode(scope, value) }}>
    {children(mode)}
  </WorkspaceModeContext.Provider>
}

export function WorkspaceModeSwitch(): React.JSX.Element | null {
  const context = useContext(WorkspaceModeContext)
  if (context === null) return null
  const zh = context.locale === 'zh-CN'
  return <ToggleGroup aria-label={zh ? '门诊与住院' : 'Outpatient and inpatient'} className="w-full" size="sm" spacing={0} value={[context.mode]} variant="outline"
    onValueChange={values => {
      const mode = values[0]
      if (mode === 'outpatient' || mode === 'inpatient') context.onChange(mode)
    }}>
    <ToggleGroupItem className="flex-1" value="outpatient">{zh ? '门诊' : 'Outpatient'}</ToggleGroupItem>
    <ToggleGroupItem className="flex-1" value="inpatient">{zh ? '住院' : 'Inpatient'}</ToggleGroupItem>
  </ToggleGroup>
}
