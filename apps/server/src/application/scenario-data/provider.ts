import type {
  ScenarioDatasetContent,
  ScenarioGenerationRequest,
  ScenarioProviderCapabilities,
} from '@clinmesh/contracts/scenario'
import { canonicalJsonHash } from './canonical-json.ts'

export const generatedScenarioSimulatorRules = [
  { code: 'success', outcome: 'success', simulator: 'payment' },
  { code: 'decline', outcome: 'declined', simulator: 'payment' },
  { code: 'ambiguous', outcome: 'ambiguous', simulator: 'payment' },
  { code: 'default-success', outcome: 'success', simulator: 'lis' },
] satisfies ScenarioDatasetContent['simulatorRules']

export interface SourcePatientArtifact {
  format: 'clinmesh-template' | 'fhir-r4-bundle' | 'legacy-compiled-profile'
  hash: string
  patientId: string
  raw: unknown | null
}

export interface SourcePatientCorpus {
  content: ScenarioDatasetContent
  kind: 'case-truth'
  sources: SourcePatientArtifact[]
}

export const sourceArtifactHash = canonicalJsonHash

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
