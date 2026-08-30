import type { WorkspaceLocale } from './workspace-i18n.ts'
import { SyntheticPatientLibrary } from './synthetic-patient-library.tsx'

export function ScenarioDataWorkspace({ locale }: { locale: WorkspaceLocale }): React.JSX.Element {
  return <SyntheticPatientLibrary locale={locale} />
}
