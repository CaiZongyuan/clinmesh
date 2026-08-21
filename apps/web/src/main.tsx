import '@clinmesh/ui/styles.css'
import { AppShell } from '@clinmesh/views/app-shell'
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

const HisFlowPrototype = lazy(() => import('./prototype/his-flow/his-flow-prototype'))

const root = document.getElementById('root')
if (root === null) throw new Error('ClinMesh web root element is missing.')

const content = window.location.pathname === '/prototype/his-flow' ? (
  <Suspense fallback={<div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">正在加载门诊原型…</div>}>
    <HisFlowPrototype />
  </Suspense>
) : (
  <AppShell platform="web" />
)

createRoot(root).render(
  <StrictMode>
    {content}
  </StrictMode>,
)
