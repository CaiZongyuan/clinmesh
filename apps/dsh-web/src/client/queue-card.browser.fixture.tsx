import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryHistory } from '@tanstack/react-router'
import { WebApp } from '../../../web/src/app/web-app.tsx'

const host = document.createElement('div')
host.dataset.queueCardHost = ''
host.style.cssText = 'width:1101px;height:900px'
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('div')
root.style.height = '100%'
shadow.append(root)
createRoot(root).render(<WebApp
  history={createMemoryHistory({ initialEntries: [document.documentElement.dataset.route ?? '/registration'] })}
  runtime={{ mode: 'surface' }}
/>)
