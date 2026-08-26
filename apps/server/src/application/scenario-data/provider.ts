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
  generate(request: ScenarioGenerationRequest): Promise<SourcePatientCorpus>
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
