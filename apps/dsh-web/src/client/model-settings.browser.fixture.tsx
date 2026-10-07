import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelSetting } from './model-settings.tsx'

let selected = 'default'
let revision = 1
const refreshFailure = document.documentElement.dataset.refreshFailure
const remote = {
  settings: {
    describe: async () => {
      if (revision > 1 && refreshFailure === 'settings') throw new Error('Synthetic settings refresh failure')
      return { ok: true, value: { writable: true, namespaces: [{ ns: 'clinmesh-dsh-web', revision, value: { generationModel: selected } }] } }
    },
    update: async (_namespace: string, patch: { generationModel: string }, expected: number) => {
      if (revision !== expected) throw new Error('Conflict')
      selected = patch.generationModel; revision++
      document.documentElement.dataset.savedModel = selected
      document.documentElement.dataset.savedRevision = String(revision)
      return { ok: true, value: { ns: 'clinmesh-dsh-web', revision, value: { generationModel: selected } } }
    },
  },
  session: { modelCatalog: async () => {
    if (revision > 1 && refreshFailure === 'catalog') throw new Error('Synthetic catalog refresh failure')
    return { ok: true, value: { default: { provider: 'a', model: 'same' },
      groups: ['a', 'b'].map(id => ({ id, name: `Provider ${id}`, models: [{ id: 'same', name: 'Synthetic model' }] })), failures: [] } }
  } },
}
const container = document.createElement('div')
document.body.append(container)
createRoot(container).render(<QueryClientProvider client={new QueryClient()}>
  <ModelSetting remote={remote} language={document.documentElement.lang === 'en-US' ? 'en-US' : 'zh-CN'} />
</QueryClientProvider>)
