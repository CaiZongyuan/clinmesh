import type { SessionContext } from '@clinmesh/contracts/his'
import type { WorkspaceSection } from './workspace-shell.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { RegistrarWorkspace } from './registrar-workspace.tsx'
import { TriageWorkspace } from './triage-workspace.tsx'
import { DoctorWorkspace } from './doctor-workspace.tsx'
import { BillingWorkspace } from './billing-workspace.tsx'
import { PharmacyWorkspace } from './pharmacy-workspace.tsx'
import { ScenarioDataWorkspace } from './scenario-data-workspace.tsx'

interface RoleWorkspaceProps {
  activeSection: WorkspaceSection
  locale: WorkspaceLocale
  session: SessionContext
}

export function RoleWorkspace({ activeSection, locale, session }: RoleWorkspaceProps): React.JSX.Element {
  if (session.actor.roleCode === 'administrator' && activeSection === 'scenarioData') {
    return <ScenarioDataWorkspace locale={locale} />
  }
  if (
    session.actor.roleCode === 'registrar'
    && activeSection === 'registration'
  ) {
    return <RegistrarWorkspace locale={locale} session={session} />
  }
  if (
    session.actor.roleCode === 'triage-nurse'
    && activeSection === 'triage'
  ) {
    return <TriageWorkspace locale={locale} session={session} />
  }
  if (
    session.actor.roleCode === 'outpatient-doctor'
    && activeSection === 'consultation'
  ) {
    return <DoctorWorkspace locale={locale} session={session} />
  }
  if (
    session.actor.roleCode === 'cashier'
    && activeSection === 'billing'
  ) {
    return <BillingWorkspace locale={locale} session={session} />
  }
  if (
    session.actor.roleCode === 'pharmacist'
    && activeSection === 'pharmacy'
  ) {
    return <PharmacyWorkspace locale={locale} session={session} />
  }
  return <div />
}
