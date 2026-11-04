import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { Button } from '@clinmesh/ui/components/button'
import { Badge } from '@clinmesh/ui/components/badge'
import { TabsContent } from '@clinmesh/ui/components/tabs'
import { InpatientItemRow, InpatientPatientHeader, InpatientQueueGroup, InpatientStageCard, InpatientTabs } from '../../../web/src/app/inpatient-layout.tsx'
import { WorkspaceActionBar, WorkspaceCardLayout, WorkspaceQueueCard } from '../../../web/src/app/workspace-card-layout.tsx'
import { InpatientNumber } from '../../../web/src/app/inpatient-number.tsx'

const host = document.createElement('div')
host.style.cssText = 'width:1101px;height:800px'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('main')
root.className = 'clinmesh-web-root'
root.setAttribute('data-clinmesh-app', '')
root.setAttribute('data-font-size', 'standard')
root.style.height = '100%'
shadow.append(root)
const tabs = ['诊断医嘱', '检查检验', '手术', 'DRG 预分组', '出院', '病案'].map((label, index) => ({ value: String(index), label, count: index === 0 ? 2 : 0 }))
function Fixture() {
  const [active, setActive] = React.useState('0'), [done, setDone] = React.useState(false)
  return <section className="clinmesh-inpatient-workspace flex h-full min-h-0 flex-col"><WorkspaceCardLayout id="inpatient-shared-layout" locale="zh-CN"
    queue={<WorkspaceQueueCard title="本病区"><InpatientQueueGroup title="新入院" count={1}><div data-inpatient-queue-items><Button variant="ghost" aria-current="true">合成住院患者</Button></div></InpatientQueueGroup><InpatientQueueGroup title="床位" count={1}><p>1床 · 轮到你 2 项</p></InpatientQueueGroup></WorkspaceQueueCard>}
    patient={<section aria-label="当前住院患者"><InpatientPatientHeader name="合成住院患者" identity="女 · 46 岁" status="在院" location="住院病区 · 1床 · 住院第 2 天"
      details={<><InpatientNumber locale="zh-CN" number="ZY-2026-synthetic-long-admission-0001" /><span>预交金 ¥1,000.00</span><span>累计费用 ¥50.00</span></>} /></section>}
    action={<WorkspaceActionBar reason="还差：逐条校对医嘱" tone="blocked" action={<Button disabled>确认医嘱</Button>} />}>
      <InpatientTabs id="inpatient-shared-tabs" locale="zh-CN" items={tabs} value={active} onValueChange={setActive}>{tabs.map(tab => <TabsContent key={tab.value} value={tab.value}>
        <InpatientStageCard title={tab.label} turn="轮到你：逐条校对医嘱" owners={<ol aria-label="办理顺序" className="flex gap-2"><li>医生开立</li><li><strong>护士校对</strong></li><li>药师发药</li></ol>}>
          <InpatientItemRow title="合成氨氯地平片" badge={<Badge variant="outline">长期</Badge>} metadata="QD · 每次 1片 · 5 mg" complete={done}
            actions={done ? <Badge variant="outline">已校对</Badge> : <Button onClick={() => setDone(true)}>校对医嘱</Button>} />
        </InpatientStageCard>
      </TabsContent>)}</InpatientTabs>
    </WorkspaceCardLayout></section>
}
createRoot(root).render(<PortalContainerProvider container={root}><Fixture /></PortalContainerProvider>)
