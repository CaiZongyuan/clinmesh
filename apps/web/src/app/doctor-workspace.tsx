import { lazy, Suspense, useState } from 'react'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { DoctorWorkspace as OutpatientWorkspace } from './doctor/doctor-case-controller.tsx'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const DrgSimulation = lazy(() => import('./drg-simulation.tsx').then(module => ({ default: module.DrgSimulation })))

export function DoctorWorkspace({ locale, session }: { locale: WorkspaceLocale, session: SessionContext }) {
  const [view, setView] = useState('outpatient')
  return <Tabs value={view} onValueChange={setView} className="flex h-full min-h-0 flex-col gap-0">
    <div className="shrink-0 border-b px-4 py-2">
      <TabsList aria-label="诊疗工作区"><TabsTrigger value="outpatient">{locale === 'en-US' ? 'Outpatient' : '门诊诊疗'}</TabsTrigger><TabsTrigger value="drg">{locale === 'en-US' ? 'Inpatient DRG simulation' : '住院 DRG 模拟'}</TabsTrigger></TabsList>
    </div>
    <TabsContent value="outpatient" className="flex min-h-0 flex-1 flex-col"><OutpatientWorkspace locale={locale} session={session} /></TabsContent>
    <TabsContent value="drg" className="flex min-h-0 flex-1 flex-col"><Suspense fallback={<p role="status">正在加载住院模拟…</p>}><DrgSimulation key={`${session.actor.workspaceId}:${session.actor.epoch}:${session.actor.practitionerRoleId}`} session={session} /></Suspense></TabsContent>
  </Tabs>
}
