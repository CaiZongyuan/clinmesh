import { VirtualTimeControl } from './virtual-time-control.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { SyntheticPatientLibrary } from './synthetic-patient-library.tsx'

export function ScenarioDataWorkspace({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  return <div className="flex min-h-0 flex-1 flex-col overflow-auto"><VirtualTimeControl locale={locale} /><SyntheticPatientLibrary locale={locale} /></div>
}
