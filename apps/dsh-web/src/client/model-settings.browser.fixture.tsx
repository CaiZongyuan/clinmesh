import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ModelSetting, type ModelSettingsPatch } from './model-settings.tsx'
import type { ModelCapabilitiesRequest, ModelCapabilitiesResponse } from '@clinmesh/contracts/model-bridge'

let values: ModelSettingsPatch = {
  generationModel: 'default',
  generationReasoningEffort: 'default',
  fastModel: 'default',
  fastReasoningEffort: 'auto-lowest',
}
let revision = 1
const refreshFailure = document.documentElement.dataset.refreshFailure
const remote = {
  settings: {
    describe: async () => {
      if (revision > 1 && refreshFailure === 'settings') throw new Error('Synthetic settings refresh failure')
      return { ok: true, value: { writable: true, namespaces: [{ ns: 'clinmesh-dsh-web', revision, value: { ...values } }] } }
    },
    update: async (_namespace: string, patch: ModelSettingsPatch, expected: number) => {
      if (revision !== expected) throw new Error('Conflict')
      values = { ...values, ...patch }
      revision++
      document.documentElement.dataset.savedModel = values.generationModel
      document.documentElement.dataset.savedFastModel = values.fastModel
      document.documentElement.dataset.savedPrimaryEffort = values.generationReasoningEffort
      document.documentElement.dataset.savedFastEffort = values.fastReasoningEffort
      document.documentElement.dataset.savedRevision = String(revision)
      return { ok: true, value: { ns: 'clinmesh-dsh-web', revision, value: { ...values } } }
    },
  },
  session: { modelCatalog: async () => {
    if (revision > 1 && refreshFailure === 'catalog') throw new Error('Synthetic catalog refresh failure')
    return {
      ok: true,
      value: {
        default: { provider: 'a', model: 'same' },
        groups: [
          { id: 'a', name: 'Provider a', models: [{ id: 'same', name: 'Synthetic reasoning model' }] },
          { id: 'b', name: 'Provider b', models: [{ id: 'same', name: 'Synthetic plain model' }] },
        ],
        failures: [],
      },
    }
  } },
}
const fetchCapabilities = async (request: ModelCapabilitiesRequest): Promise<ModelCapabilitiesResponse> => {
  if (request.provider === 'a') {
    return {
      efforts: [
        { id: 'low', name: 'Low' },
        { id: 'medium', name: 'Medium' },
        { id: 'high', name: 'High' },
      ],
      defaultEffort: 'medium',
    }
  }
  return { efforts: [] }
}
const container = document.createElement('div')
document.body.append(container)
createRoot(container).render(<QueryClientProvider client={new QueryClient()}>
  <ModelSetting
    remote={remote}
    language={document.documentElement.lang === 'en-US' ? 'en-US' : 'zh-CN'}
    fetchCapabilities={fetchCapabilities}
  />
</QueryClientProvider>)
