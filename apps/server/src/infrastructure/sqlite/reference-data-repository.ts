import type {
  ReferenceDataReleaseList,
  ReferenceMedicalService,
  ReferenceMedicationProduct,
  ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import type { ReferenceDataReader } from '../../application/reference-data-service.ts'
import {
  listReferenceDataReleases,
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

  medicationProducts(releaseId: string): ReferenceMedicationProduct[] {
    return listReferenceMedicationProducts(this.#database, releaseId)
  }

  medicalServices(releaseId: string): ReferenceMedicalService[] {
    return listReferenceMedicalServices(this.#database, releaseId)
  }

  valueSetEntries(releaseId: string): ReferenceValueSetEntry[] {
    return listReferenceValueSetEntries(this.#database, releaseId)
  }
}
