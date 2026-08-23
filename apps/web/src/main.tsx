import '@clinmesh/ui/styles.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WebApp } from './app/web-app.tsx'

const root = document.getElementById('root')
if (root === null) throw new Error('ClinMesh web root element is missing.')

createRoot(root).render(
  <StrictMode>
    <WebApp />
  </StrictMode>,
)
