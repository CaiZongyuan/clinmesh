import type {
  ReferenceDataReleaseList,
  ReferenceMedicationProduct,
} from '@clinmesh/contracts/reference-data'
import type { ReferenceDataReader } from '../../application/reference-data-service.ts'
import {
  listReferenceDataReleases,
  listReferenceMedicationProducts,
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
}
