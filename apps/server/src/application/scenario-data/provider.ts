import type {
  ScenarioGenerationRequest,
  ScenarioProviderCapabilities,
  SyntheaCnLocalizationProvenance,
  SyntheaKeepCriteria,
  SyntheaTranslationWarning,
} from '@clinmesh/contracts/scenario'
import { canonicalJsonHash } from './canonical-json.ts'

export interface SourcePatientArtifact {
  format: 'fhir-r4-bundle'
  hash: string
  localization?: SyntheaCnLocalizationProvenance
  translationWarning?: SyntheaTranslationWarning
  patientId: string
  raw: unknown
}

export interface SourcePatientCorpus {
  kind: 'synthea-r4'
  sources: SourcePatientArtifact[]
}

export const sourceArtifactHash = canonicalJsonHash

export interface ScenarioGenerationProvider {
  capabilities(): Promise<ScenarioProviderCapabilities>
  /** `keep` 只在 Provider 声明 `targetedGeneration` 时传入；请求中的 `target` 由 Server 消费，不发给 Provider。 */
  generate(
    request: ScenarioGenerationRequest,
    signal?: AbortSignal,
    keep?: SyntheaKeepCriteria,
  ): Promise<SourcePatientCorpus>
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
