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
  searchReferenceConceptCatalog,
  searchReferenceLaboratoryRecords,
  searchReferenceMedicationCatalog,
  getReferenceConceptById,
  getReferenceLaboratoryRecord,
  getReferenceMedicationProductById,
  type ReferenceCatalogSearchInput,
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

  searchConcepts(
    releaseId: string,
    domain: 'diagnosis' | 'laboratory',
    input: ReferenceCatalogSearchInput,
  ) {
    return searchReferenceConceptCatalog(this.#database, releaseId, domain, input)
  }

  searchMedicationProducts(releaseId: string, input: ReferenceCatalogSearchInput) {
    return searchReferenceMedicationCatalog(this.#database, releaseId, input)
  }

  searchLaboratoryRecords(releaseId: string, input: ReferenceCatalogSearchInput) {
    return searchReferenceLaboratoryRecords(this.#database, releaseId, input)
  }

  conceptById(
    releaseId: string,
    domain: 'diagnosis' | 'laboratory',
    conceptId: string,
  ) {
    return getReferenceConceptById(this.#database, releaseId, domain, conceptId)
  }

  medicationProductById(releaseId: string, productId: string) {
    return getReferenceMedicationProductById(this.#database, releaseId, productId)
  }

  laboratoryRecord(releaseId: string, conceptId: string) {
    return getReferenceLaboratoryRecord(this.#database, releaseId, conceptId)
  }
}
