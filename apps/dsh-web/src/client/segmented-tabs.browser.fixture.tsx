import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { Tabs, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { WorkspaceModeProvider, WorkspaceModeSwitch } from '../../../web/src/app/workspace-mode.tsx'

// 合同目标：分段页签与下划线页签由指示器标出选中项并随切换移动；视图切换不沿用表单选项的实心带勾。
function Panel({ theme }: { theme: 'light' | 'dark' }) {
  const [queue, setQueue] = React.useState('active')
  const [status, setStatus] = React.useState('pending')
  const [section, setSection] = React.useState('consultation')
  const [option, setOption] = React.useState(['a'])
  return <div className={`clinmesh-web-root${theme === 'dark' ? ' dark' : ''}`} data-theme-root={theme} style={{ width: 232, padding: 12, background: 'var(--card)' }}>
    <section className="clinmesh-card-workspace" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <WorkspaceModeProvider locale="zh-CN" scope={`segmented-${theme}`}>{() => <WorkspaceModeSwitch />}</WorkspaceModeProvider>
      <Tabs value={queue} onValueChange={value => setQueue(String(value))}>
        <TabsList aria-label="队列" className="h-auto! w-full flex-wrap">
          <TabsTrigger value="active">在诊</TabsTrigger><TabsTrigger value="waiting">待诊</TabsTrigger><TabsTrigger value="completed">完诊</TabsTrigger>
        </TabsList>
      </Tabs>
      <Tabs value={status} onValueChange={value => setStatus(String(value))}>
        <TabsList aria-label="缴费状态" className="grid h-auto! w-full grid-cols-2">
          {[['pending', '待缴'], ['paid', '已缴'], ['declined', '已拒绝'], ['ambiguous', '结果未知']].map(([value, label]) =>
            <TabsTrigger key={value} className="min-w-0 flex-1 wrap-anywhere whitespace-normal" value={value!}>{label}</TabsTrigger>)}
        </TabsList>
      </Tabs>
      <Tabs value={section} onValueChange={value => setSection(String(value))}>
        <TabsList aria-label="工作分区" variant="line">
          <TabsTrigger value="consultation">问诊</TabsTrigger><TabsTrigger value="record">病历</TabsTrigger><TabsTrigger value="orders">检查</TabsTrigger>
        </TabsList>
      </Tabs>
      <ToggleGroup aria-label="合成选项" value={option} variant="outline" onValueChange={values => { if (values.length) setOption(values) }}>
        <ToggleGroupItem value="a">甲</ToggleGroupItem><ToggleGroupItem value="b">乙</ToggleGroupItem>
      </ToggleGroup>
    </section>
  </div>
}

const container = document.createElement('div')
container.style.cssText = 'display: flex; gap: 24px; padding: 24px;'
document.body.append(container)
flushSync(() => createRoot(container).render(<><Panel theme="light" /><Panel theme="dark" /></>))
document.title = btoa(JSON.stringify({ ready: true }))
