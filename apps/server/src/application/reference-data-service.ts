import {
  referenceDiagnosisCatalogSearchSchema,
  referenceDataProvenanceSchema,
  referenceDataReleaseListSchema,
  referenceLaboratoryCatalogSearchSchema,
  referenceMedicationCatalogSearchSchema,
  type ReferenceConcept,
  type ReferenceDataReleaseList,
  type ReferenceDataReleaseSummary,
  type ReferenceLaboratoryRecord,
  type ReferenceMedicalService,
  type ReferenceMedicationProduct,
  type ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import type { ActorContext } from './command-executor.ts'
import { syntheticNhsaMedicationProductSnapshot } from './scenario-data/medication-product-snapshot.ts'
import {
  syntheticNhcMedicalServiceSnapshot,
  syntheticWstValueSetSnapshot,
} from './scenario-data/medical-service-snapshot.ts'

const BUILTIN_RELEASE_CONTENT_HASH = 'bc1e7ca7e11e31851acd651705ab627b45ff459c79dcca3aa1ebb32c81ae0b5e'
const BUILTIN_RELEASE_ID = 'clinmesh-hospital-reference-fixture-2026-08-28'

export interface ReferenceDataReader {
  conceptById?(
    releaseId: string,
    domain: 'diagnosis' | 'laboratory',
    conceptId: string,
  ): ReferenceConcept | undefined
  concepts(
    releaseId: string,
    codings: readonly { code: string; system: string; version: string }[],
  ): ReferenceConcept[]
  list(): ReferenceDataReleaseList
  laboratoryRecord?(releaseId: string, conceptId: string): ReferenceLaboratoryRecord | undefined
  medicalServices(releaseId: string): ReferenceMedicalService[]
  medicationProducts(
    releaseId: string,
    codings?: readonly { code: string; system: string; version: string }[],
  ): ReferenceMedicationProduct[]
  medicationProductById?(
    releaseId: string,
    productId: string,
  ): ReferenceMedicationProduct | undefined
  searchConcepts?(
    releaseId: string,
    domain: 'diagnosis' | 'laboratory',
    input: { page: number; pageSize: number; query?: string },
  ): { items: ReferenceConcept[]; total: number }
  searchLaboratoryRecords?(
    releaseId: string,
    input: { page: number; pageSize: number; query?: string },
  ): { items: ReferenceLaboratoryRecord[]; total: number }
  searchMedicationProducts?(
    releaseId: string,
    input: { page: number; pageSize: number; query?: string },
  ): { items: ReferenceMedicationProduct[]; total: number }
  valueSetEntries(releaseId: string): ReferenceValueSetEntry[]
}

export class ReferenceDataError extends Error {
  readonly code: 'REFERENCE_DATA_UNAVAILABLE' | 'REFERENCE_RELEASE_AMBIGUOUS' | 'REFERENCE_RELEASE_NOT_FOUND' | 'ROLE_NOT_ALLOWED'
  readonly status: 403 | 503

  constructor(
    code: 'REFERENCE_DATA_UNAVAILABLE' | 'REFERENCE_RELEASE_AMBIGUOUS' | 'REFERENCE_RELEASE_NOT_FOUND' | 'ROLE_NOT_ALLOWED',
    message: string,
  ) {
    super(message)
    this.name = 'ReferenceDataError'
    this.code = code
    this.status = code === 'ROLE_NOT_ALLOWED' ? 403 : 503
  }
}

function builtinReferenceData(): ReferenceDataReleaseList {
  // These hashes pin the synthetic hospital reference manifest; changing a source requires a new release ID.
  return referenceDataReleaseListSchema.parse({
    items: [{
      conceptCount: 0,
      contentHash: BUILTIN_RELEASE_CONTENT_HASH,
      createdAt: '2026-08-28T00:00:00.000Z',
      medicationProductCount: syntheticNhsaMedicationProductSnapshot.length,
      releaseId: BUILTIN_RELEASE_ID,
      schemaVersion: '1',
      serviceCount: syntheticNhcMedicalServiceSnapshot.length,
      sourceCount: 3,
      sources: [{
        artifactFormat: 'nhsa-medication-product-csv',
        acquisitionMethod: 'generated',
        checksum: 'b72aa94f14b640dc9bc2952d687728995cc06a137da734b2b74bbffb64256c93',
        importDiagnostics: {
          acceptedCount: syntheticNhsaMedicationProductSnapshot.length,
          rejectedCount: 0,
          warnings: [],
        },
        licenseId: 'LicenseRef-ClinMesh-Proprietary',
        recordCount: syntheticNhsaMedicationProductSnapshot.length,
        retrievedAt: '2026-08-28T00:00:00.000Z',
        sourceId: 'clinmesh-synthetic-nhsa-medication-products',
        sourceUrl: 'https://github.com/CaiZongyuan/clinmesh/issues/47',
        upstreamVersion: 'nhsa-medication-products-2026-08-07',
      }, {
        acquisitionMethod: 'generated',
        artifactFormat: 'nhc-medical-service-csv',
        checksum: '8ed125b9d880f39ff0e7a503229e4bd1d69772ec86ee6c19808d6c68eca3954b',
        importDiagnostics: {
          acceptedCount: syntheticNhcMedicalServiceSnapshot.length,
          rejectedCount: 0,
          warnings: [],
        },
        licenseId: 'LicenseRef-ClinMesh-Proprietary',
        recordCount: syntheticNhcMedicalServiceSnapshot.length,
        retrievedAt: '2026-08-28T00:00:00.000Z',
        sourceId: 'clinmesh-synthetic-nhc-medical-services',
        sourceUrl: 'https://github.com/CaiZongyuan/clinmesh/issues/48',
        upstreamVersion: 'nhc-medical-services-2026-08-28',
      }, {
        acquisitionMethod: 'generated',
        artifactFormat: 'wst-value-set-csv',
        checksum: '36fc6be3ab504b8f48f1cacedaac2aaae42c648ee8cd2bb6cded99a130b05a13',
        importDiagnostics: {
          acceptedCount: syntheticWstValueSetSnapshot.length,
          rejectedCount: 0,
          warnings: [],
        },
        licenseId: 'LicenseRef-ClinMesh-Proprietary',
        recordCount: syntheticWstValueSetSnapshot.length,
        retrievedAt: '2026-08-28T00:00:00.000Z',
        sourceId: 'clinmesh-synthetic-wst-value-set',
        sourceUrl: 'https://github.com/CaiZongyuan/clinmesh/issues/48',
        upstreamVersion: 'WS-T-CM-2026',
      }],
      status: 'published',
      valueSetEntryCount: syntheticWstValueSetSnapshot.length,
    }],
  })
}

export class ReferenceDataService {
  readonly #activeReleaseId: string | undefined
  readonly #reader: ReferenceDataReader | undefined

  constructor(
    reader?: ReferenceDataReader,
    activeReleaseId?: string,
  ) {
    this.#activeReleaseId = activeReleaseId
    this.#reader = reader
  }

  list(context: ActorContext): ReferenceDataReleaseList {
    if (context.roleCode !== 'administrator') {
      throw new ReferenceDataError(
        'ROLE_NOT_ALLOWED',
        'Only an administrator can read Reference Data releases',
      )
    }
    return this.#releases()
  }

  current(): ReferenceDataReleaseList['items'][number] {
    return this.#catalogRelease()
  }

  provenance() {
    const release = this.current()
    return referenceDataProvenanceSchema.parse({
      contentHash: release.contentHash,
      releaseId: release.releaseId,
    })
  }

  searchDiagnoses(
    context: ActorContext,
    input: { page: number; pageSize: number; query?: string },
  ) {
    this.#assertCatalogReader(context)
    const release = this.#catalogRelease()
    const result = this.#reader?.searchConcepts === undefined
      ? { items: [], total: 0 }
      : this.#reader.searchConcepts(release.releaseId, 'diagnosis', input)
    return referenceDiagnosisCatalogSearchSchema.parse({
      ...result,
      page: input.page,
      pageSize: input.pageSize,
      releaseId: release.releaseId,
    })
  }

  searchLaboratory(
    context: ActorContext,
    input: { page: number; pageSize: number; query?: string },
  ) {
    this.#assertCatalogReader(context)
    const release = this.#catalogRelease()
    const result = this.#reader?.searchConcepts === undefined
      ? { items: [], total: 0 }
      : this.#reader.searchConcepts(release.releaseId, 'laboratory', input)
    return referenceLaboratoryCatalogSearchSchema.parse({
      ...result,
      page: input.page,
      pageSize: input.pageSize,
      releaseId: release.releaseId,
    })
  }

  laboratoryRecord(context: ActorContext, conceptId: string): ReferenceLaboratoryRecord | undefined {
    this.#assertCatalogReader(context)
    const release = this.#catalogRelease()
    return this.#reader?.laboratoryRecord?.(release.releaseId, conceptId)
  }

  laboratoryRecordFromRelease(
    context: ActorContext,
    releaseId: string,
    conceptId: string,
  ): ReferenceLaboratoryRecord | undefined {
    if (context.roleCode !== 'administrator') {
      throw new ReferenceDataError(
        'ROLE_NOT_ALLOWED',
        'Only an administrator can configure Laboratory Services',
      )
    }
    const releaseExists = this.#releases().items.some(item => item.releaseId === releaseId)
    if (!releaseExists) {
      throw new ReferenceDataError(
        'REFERENCE_RELEASE_NOT_FOUND',
        'The Laboratory Service publication Reference Release was not found',
      )
    }
    return this.#reader?.laboratoryRecord?.(releaseId, conceptId)
  }

  searchLaboratoryCandidates(
    context: ActorContext,
    input: { page: number; pageSize: number; query?: string },
  ) {
    if (context.roleCode !== 'administrator') {
      throw new ReferenceDataError(
        'ROLE_NOT_ALLOWED',
        'Only an administrator can configure Laboratory Services',
      )
    }
    const release = this.#catalogRelease()
    const result = this.#reader?.searchLaboratoryRecords === undefined
      ? { items: [], total: 0 }
      : this.#reader.searchLaboratoryRecords(release.releaseId, input)
    return { ...result, referenceReleaseId: release.releaseId }
  }

  searchMedications(
    context: ActorContext,
    input: { page: number; pageSize: number; query?: string },
  ) {
    this.#assertCatalogReader(context)
    const release = this.#catalogRelease()
    const result = this.#reader?.searchMedicationProducts === undefined
      ? this.#searchBuiltinMedications(input)
      : this.#reader.searchMedicationProducts(release.releaseId, input)
    return referenceMedicationCatalogSearchSchema.parse({
      ...result,
      page: input.page,
      pageSize: input.pageSize,
      releaseId: release.releaseId,
    })
  }

  diagnosisById(context: ActorContext, conceptId: string): ReferenceConcept | undefined {
    this.#assertCatalogReader(context)
    const release = this.#catalogRelease()
    const concept = this.#reader?.conceptById?.(release.releaseId, 'diagnosis', conceptId)
    return concept?.status === 'active' ? concept : undefined
  }

  laboratoryById(context: ActorContext, conceptId: string): ReferenceConcept | undefined {
    this.#assertCatalogReader(context)
    const release = this.#catalogRelease()
    const concept = this.#reader?.conceptById?.(release.releaseId, 'laboratory', conceptId)
    return concept?.status === 'active' ? concept : undefined
  }

  medicationById(
    context: ActorContext,
    productId: string,
  ): ReferenceMedicationProduct | undefined {
    this.#assertCatalogReader(context)
    const release = this.#catalogRelease()
    const product = this.#reader?.medicationProductById === undefined
      ? syntheticNhsaMedicationProductSnapshot.find(item => item.id === productId)
      : this.#reader.medicationProductById(release.releaseId, productId)
    return product?.status === 'active' ? product : undefined
  }

  #assertCatalogReader(context: ActorContext): void {
    if (!['administrator', 'outpatient-doctor'].includes(context.roleCode)) {
      throw new ReferenceDataError(
        'ROLE_NOT_ALLOWED',
        'This role cannot read the clinical Reference catalogs',
      )
    }
  }

  #catalogRelease(): ReferenceDataReleaseSummary {
    if (this.#reader === undefined) return builtinReferenceData().items[0]!
    const releases = this.#reader.list().items
    const releaseId = this.#activeReleaseId
    if (releaseId !== undefined) {
      const release = releases.find(item => item.releaseId === releaseId)
      if (release === undefined) {
        throw new ReferenceDataError(
          'REFERENCE_RELEASE_NOT_FOUND',
          'The configured current Reference Data Release was not found',
        )
      }
      return release
    }
    if (releases.length === 1) return releases[0]!
    if (releases.length === 0) {
      throw new ReferenceDataError(
        'REFERENCE_DATA_UNAVAILABLE',
        'No published Reference Data Release is available',
      )
    }
    throw new ReferenceDataError(
      'REFERENCE_RELEASE_AMBIGUOUS',
      'A current Reference Data Release must be configured when multiple releases exist',
    )
  }

  #searchBuiltinMedications(input: { page: number; pageSize: number; query?: string }) {
    const query = input.query?.toLocaleLowerCase('zh-CN')
    const items = syntheticNhsaMedicationProductSnapshot.filter(product => (
      query === undefined
      || [product.code, product.genericName, product.brandName, product.manufacturer]
        .some(value => value?.toLocaleLowerCase('zh-CN').includes(query) === true)
    )).toSorted((left, right) => (
      left.genericName.localeCompare(right.genericName, 'zh-CN')
      || left.code.localeCompare(right.code)
      || left.id.localeCompare(right.id)
    ))
    return {
      items: items.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
      total: items.length,
    }
  }

  #releases(): ReferenceDataReleaseList {
    const releases = this.#reader?.list()
    if (releases === undefined || releases.items.length === 0) return builtinReferenceData()
    if (releases.items.some(release => (
      release.medicationProductCount > 0
      && release.serviceCount > 0
      && release.valueSetEntryCount > 0
    ))) return releases
    const builtin = builtinReferenceData().items[0]!
    return referenceDataReleaseListSchema.parse({
      items: [
        ...releases.items,
        ...(releases.items.some(release => release.releaseId === builtin.releaseId) ? [] : [builtin]),
      ],
    })
  }
}
