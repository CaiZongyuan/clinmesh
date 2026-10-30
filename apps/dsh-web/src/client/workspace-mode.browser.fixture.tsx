import { useMemo, useRef, useState } from 'react'
import { z } from 'zod'
import { createRoot } from 'react-dom/client'
import { createMemoryHistory } from '@tanstack/react-router'
import { WebApp } from '../../../web/src/app/web-app.tsx'
import type { WebRuntimeOptions, WebSurfaceAgentController, WebSurfaceAgentTool } from '../../../web/src/app/web-runtime.tsx'

const host = document.createElement('div')
host.style.cssText = 'width:944px;height:900px'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('main')
root.style.height = '100%'
shadow.append(root)
const history = createMemoryHistory({ initialEntries: ['/billing'] })

function Host() {
  const [names, setNames] = useState<readonly string[]>([])
  const tools = useRef<readonly WebSurfaceAgentTool[]>([])
  const [result, setResult] = useState('')
  const agent = useMemo<WebSurfaceAgentController>(() => ({ register(registration) {
    tools.current = registration.tools
    setNames(registration.tools.map(tool => tool.name))
    return () => { tools.current = []; setNames([]) }
  } }), [])
  const runtime = useMemo<WebRuntimeOptions>(() => ({ mode: 'surface', surfaceActive: true,
    surfaceAgentStatus: 'active', surfaceAgent: agent, surfaceSessionId: 'workspace-mode-session',
    surfaceColorScheme: 'light', surfaceLocale: 'zh-CN' }), [agent])
  async function navigate(destination: 'billing' | 'inpatient') {
    try {
      const tool = tools.current.find(tool => tool.name === 'clinmesh_navigate')
      if (!tool) throw new Error('导航工具尚未发布')
      const binding = z.object({ properties: z.object({
        scopeKey: z.object({ const: z.string() }), pageRevision: z.object({ const: z.string() }),
      }) }).parse(tool.parameters)
      setResult(await tool.execute({ destination, scopeKey: binding.properties.scopeKey.const,
        pageRevision: binding.properties.pageRevision.const }, new AbortController().signal))
    } catch (error) { setResult(error instanceof Error ? error.message : '导航失败') }
  }
  return <><output aria-label="宿主已发布工具">{names.join('\n')}</output>
    <button onClick={() => void navigate('inpatient')}>助手切换住院</button>
    <button onClick={() => void navigate('billing')}>助手切换门诊</button>
    <output aria-label="助手导航结果">{result}</output><WebApp history={history} runtime={runtime} /></>
}
createRoot(root).render(<Host />)
