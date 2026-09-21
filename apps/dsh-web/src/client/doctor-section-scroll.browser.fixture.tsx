import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { DoctorCaseDetailRegion, DoctorCaseLayout, DoctorCasePanel, DoctorWorkspaceLayout } from '../../../web/src/app/doctor/responsive-layout.tsx'

import { PatientBanner } from '../../../web/src/app/doctor/patient-summary.tsx'
import { getWorkspaceMessages } from '../../../web/src/app/workspace-i18n.ts'
import { Button } from '@clinmesh/ui/components/button'
const detail: React.ComponentProps<typeof PatientBanner>['detail'] = {
  allergies: [], caseId: 'synthetic-case', encounter: { id: 'enc', status: 'in-progress', versionId: '1' },
  patient: { id: 'synthetic-patient', identifier: 'SYNTHETIC-00000001', name: '??????', synthetic: true, versionId: '1' },
  presentation: { chiefComplaint: '??????', summary: '????', vitalSigns: {
    bloodPressure: { diastolicMmHg: 76, systolicMmHg: 118 }, oxygenSaturationPct: 98, pulseBpm: 80, respirationBpm: 18, temperatureC: 37,
  } }, priorFacts: [], status: 'in-progress', taskId: 'task', taskVersion: '1',
}
const sections = ['record', 'laboratory', 'diagnosis', 'prescription'] as const
const host = document.createElement('div')
host.style.cssText = 'position:absolute;left:20px;top:20px;contain:strict'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
const style = document.createElement('style')
style.textContent = document.querySelector('style')!.textContent
const root = document.createElement('div')
root.className = 'clinmesh-web-root h-full min-h-0 overflow-hidden'
shadow.append(style, root)
function App() {
  return <div className="flex h-full min-h-0 flex-col">
    <DoctorWorkspaceLayout selectedCaseId="case" queueLabel="Queue" detailLabel="Case" queue={() => <div>Queue</div>}>
      <DoctorCaseDetailRegion><div role="status" className="shrink-0">Synthetic success notification</div><DoctorCaseLayout railPlacement="host" contextLabel="Context" rail={() => null}>
        <div className="flex min-h-0 flex-1 flex-col">
          <PatientBanner detail={detail} messages={getWorkspaceMessages('zh-CN')} statusText="???" onShowContext={() => {}} completionAction={<Button>??</Button>} />
          <Tabs defaultValue="record" className="min-h-0 flex-1 gap-0">
            <div className="shrink-0 overflow-x-auto"><TabsList>{sections.map(section => <TabsTrigger key={section} value={section}>{section}</TabsTrigger>)}</TabsList></div>
            {sections.map(section => <DoctorCasePanel key={section} value={section}>
              <div style={{ height: 1800 }}>{section} long content</div>
              <button>End of {section}</button>
            </DoctorCasePanel>)}
          </Tabs>
        </div>
      </DoctorCaseLayout></DoctorCaseDetailRegion>
    </DoctorWorkspaceLayout>
  </div>
}
flushSync(() => createRoot(root).render(<App />))
async function run() {
  const steps = []
  for (const [width, height] of [[1000, 700], [600, 700], [320, 520]]) {
    host.style.width = `${width}px`
    host.style.height = `${height}px`
    await new Promise(resolve => setTimeout(resolve, 150))
    for (const section of sections) {
      const tab = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === section)!
      flushSync(() => tab.click())
      const panel = root.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!
      const header = root.querySelector('[aria-label="????"]') ?? root.querySelector('[class*="patient-banner"]')!
      const tabs = root.querySelector('[role="tablist"]')!
      const headerTop = header.getBoundingClientRect().top
      const tabsTop = tabs.getBoundingClientRect().top
      panel.scrollTop = panel.scrollHeight
      panel.querySelector('button')!.scrollIntoView({ block: 'nearest' })
      const end = panel.querySelector('button')!.getBoundingClientRect()
      steps.push({ width, height, section,
        panelScrolled: panel.scrollTop > 0,
        endVisible: end.bottom <= host.getBoundingClientRect().bottom && end.top >= tabs.getBoundingClientRect().bottom,
        headerStable: header.getBoundingClientRect().top === headerTop && tabs.getBoundingClientRect().top === tabsTop,
        panelBounded: panel.getBoundingClientRect().bottom <= host.getBoundingClientRect().bottom,
      })
    }
  }
  document.title = btoa(JSON.stringify(steps))
}
void run().catch(error => { document.title = btoa(JSON.stringify({ error: String(error) })) })
