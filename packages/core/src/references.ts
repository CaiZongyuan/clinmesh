import type { FhirReference } from '@clinmesh/contracts/fhir'

export function referenceKey(reference: FhirReference): string {
  return reference.reference
}
