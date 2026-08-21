import '@clinmesh/ui/styles.css'
import { AppShell } from '@clinmesh/views/app-shell'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

const root = document.getElementById('root')
if (root === null) throw new Error('ClinMesh desktop root element is missing.')

createRoot(root).render(
  <StrictMode>
    <AppShell platform="desktop" />
  </StrictMode>,
)
