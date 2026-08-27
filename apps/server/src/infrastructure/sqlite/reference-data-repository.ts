import type { ReferenceDataReleaseList } from '@clinmesh/contracts/reference-data'
import type { ReferenceDataReader } from '../../application/reference-data-service.ts'
import {
  listReferenceDataReleases,
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
}
