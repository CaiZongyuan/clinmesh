import { InpatientPharmacy } from './inpatient-pharmacy.tsx'
import { InpatientWorkspace } from './inpatient-workspace.tsx'
import type { SessionContext } from '@clinmesh/contracts/his'
import type { WorkspaceSection } from './workspace-shell.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { RegistrarWorkspace } from './registrar-workspace.tsx'
import { TriageWorkspace } from './triage-workspace.tsx'
import { DoctorWorkspace } from './doctor-workspace.tsx'
import { BillingWorkspace } from './billing-workspace.tsx'
import { PharmacyWorkspace } from './pharmacy-workspace.tsx'
import { ScenarioDataWorkspace } from './scenario-data-workspace.tsx'
import { WorkspaceModeProvider, workspaceModeScope } from './workspace-mode.tsx'

interface RoleWorkspaceProps {
  activeSection: WorkspaceSection
  locale: WorkspaceLocale
  session: SessionContext
}

export function RoleWorkspace({ activeSection, locale, session }: RoleWorkspaceProps): React.JSX.Element {
  const role = session.actor.roleCode
  if (role === 'registrar' || role === 'cashier' || role === 'pharmacist') {
    const section = role === 'registrar' ? 'registration' : role === 'cashier' ? 'billing' : 'pharmacy'
    if (activeSection === section) {
      const Outpatient = role === 'registrar' ? RegistrarWorkspace : role === 'cashier' ? BillingWorkspace : PharmacyWorkspace
      const Inpatient = role === 'pharmacist' ? InpatientPharmacy : InpatientWorkspace
      return <WorkspaceModeProvider locale={locale} scope={workspaceModeScope(session)}>
        {mode => mode === 'outpatient' ? <Outpatient locale={locale} session={session} /> : <Inpatient locale={locale} session={session} />}
      </WorkspaceModeProvider>
    }
  }
  if (['inpatient-doctor', 'ward-nurse', 'medical-records', 'medical-insurance'].includes(session.actor.roleCode) && activeSection === 'inpatient') {
    return <InpatientWorkspace session={session} locale={locale} />
  }
  if (session.actor.roleCode === 'administrator' && activeSection === 'scenarioData') {
    return <ScenarioDataWorkspace locale={locale} session={session} />
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
  return <div />
}
