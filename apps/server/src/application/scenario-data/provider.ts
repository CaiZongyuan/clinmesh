import type {
  ScenarioDatasetContent,
  ScenarioGenerationRequest,
  ScenarioProviderCapabilities,
} from '@clinmesh/contracts/scenario'

export interface SourcePatientCorpus {
  content: ScenarioDatasetContent
  kind: 'case-truth'
}

export interface ScenarioGenerationProvider {
  capabilities(): Promise<ScenarioProviderCapabilities>
  generate(request: ScenarioGenerationRequest, signal?: AbortSignal): Promise<SourcePatientCorpus>
}

export class ScenarioGenerationProviderError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ScenarioGenerationProviderError'
    this.code = code
  }
}

export class UnavailableScenarioGenerationProvider implements ScenarioGenerationProvider {
  readonly #capabilities: ScenarioProviderCapabilities

  constructor(capabilities: ScenarioProviderCapabilities) {
    this.#capabilities = capabilities
  }

  async capabilities(): Promise<ScenarioProviderCapabilities> {
    return this.#capabilities
  }

  async generate(): Promise<SourcePatientCorpus> {
    throw new Error(this.#capabilities.unavailableReason ?? 'Scenario Provider is unavailable')
  }
}
