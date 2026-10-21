import type { SessionContext } from '@clinmesh/contracts/his'
import { VirtualTimeControl } from './virtual-time-control.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { SyntheticPatientLibrary } from './synthetic-patient-library.tsx'

export function ScenarioDataWorkspace({ locale, session }: { locale: WorkspaceLocale; session: SessionContext }): React.JSX.Element {
  return <div className="flex min-h-0 flex-1 flex-col overflow-auto"><VirtualTimeControl locale={locale} session={session} /><SyntheticPatientLibrary locale={locale} /></div>
}
