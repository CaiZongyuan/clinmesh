import type {
  ReferenceConcept,
  ReferenceDataReleaseList,
  ReferenceMedicalService,
  ReferenceMedicationProduct,
  ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import type { ReferenceDataReader } from '../../application/reference-data-service.ts'
import {
  listReferenceDataReleases,
  listReferenceConcepts,
  listReferenceMedicalServices,
  listReferenceMedicationProducts,
  listReferenceValueSetEntries,
  type ReferenceDatabase,
} from './reference-database.ts'

export class SqliteReferenceDataRepository implements ReferenceDataReader {
  readonly #database: ReferenceDatabase

  constructor(database: ReferenceDatabase) {
    this.#database = database
  }

  list(): ReferenceDataReleaseList {
    return listReferenceDataReleases(this.#database)
  }

  concepts(
    releaseId: string,
    codings: readonly { code: string; system: string; version: string }[],
  ): ReferenceConcept[] {
    return listReferenceConcepts(this.#database, releaseId, codings)
  }

  medicationProducts(
    releaseId: string,
    codings?: readonly { code: string; system: string; version: string }[],
  ): ReferenceMedicationProduct[] {
    return listReferenceMedicationProducts(this.#database, releaseId, codings)
  }

  medicalServices(releaseId: string): ReferenceMedicalService[] {
    return listReferenceMedicalServices(this.#database, releaseId)
  }

  valueSetEntries(releaseId: string): ReferenceValueSetEntry[] {
    return listReferenceValueSetEntries(this.#database, releaseId)
  }
}
