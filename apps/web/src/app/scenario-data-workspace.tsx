import type { SessionContext } from '@clinmesh/contracts/his'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { SyntheticPatientLibrary } from './synthetic-patient-library.tsx'

export function ScenarioDataWorkspace({ locale, session }: { locale: WorkspaceLocale; session: SessionContext }): React.JSX.Element {
  return <SyntheticPatientLibrary locale={locale} session={session} />
}
