import { pciCaseSourceSchema, type pciCaseSourcePrepareRequestSchema } from '@clinmesh/contracts/inpatient-pci-data'
import type { z } from 'zod'
import type { ActorContext, CommandExecutor } from '../command-executor.ts'
import type { SyntheticCaseRepository } from '../../infrastructure/sqlite/synthetic-case-repository.ts'
import type { SyntheticPatientProfileRepository } from '../../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { createSyntheticPatientProfiles } from './synthetic-patient-profile.ts'
import { compileSyntheaIndexCase } from './synthea-index-case.ts'
import { canonicalJsonHash } from './canonical-json.ts'
import { pciDataPackage } from './pci-data.ts'

export class PciCaseSourceError extends Error {
  constructor(readonly code: string, message: string, readonly status: 403 | 409) { super(message) }
}

/** 固定作者底稿只成为隔离的 R4 来源；本院诊疗事实仍由 HIS 命令形成。 */
function fixedPciSource() {
  const draft = pciDataPackage.caseDraft
  const time = '2026-06-01T08:00:00+08:00'
  const patientReference = 'urn:uuid:pci-patient'
  const encounterReference = 'urn:uuid:pci-index-encounter'
  const raw = { resourceType: 'Bundle', type: 'collection', entry: [
    { fullUrl: patientReference, resource: { resourceType: 'Patient', id: 'pci-patient',
      birthDate: draft.birthDate, gender: draft.gender, name: [{ text: draft.name }] } },
    { fullUrl: encounterReference, resource: { resourceType: 'Encounter', id: 'pci-index-encounter', status: 'finished',
      subject: { reference: patientReference }, period: { start: time, end: time }, reasonCode: [{ text: draft.chiefComplaint }] } },
    { fullUrl: 'urn:uuid:pci-source-condition', resource: { resourceType: 'Condition', id: 'pci-source-condition',
      subject: { reference: patientReference }, encounter: { reference: encounterReference }, recordedDate: time,
      code: { coding: [{ ...pciDataPackage.diagnosis }] }, note: [{ text: draft.history }] } },
    ...draft.baselineObservations.map((item, index) => ({ fullUrl: `urn:uuid:pci-observation-${index}`,
      resource: { resourceType: 'Observation', id: `pci-observation-${index}`, status: 'final',
        code: { coding: [{ ...item.coding }] }, subject: { reference: patientReference },
        encounter: { reference: encounterReference }, effectiveDateTime: time,
        valueQuantity: { value: item.value, system: 'http://unitsofmeasure.org', code: item.unit, unit: item.unit } },
    })),
  ] }
  return { format: 'fhir-r4-bundle' as const, hash: canonicalJsonHash(raw), patientId: 'pci-patient', raw }
}

export class PciCaseSource {
  constructor(readonly commands: CommandExecutor, readonly profiles: SyntheticPatientProfileRepository, readonly cases: SyntheticCaseRepository) {}

  prepare(context: ActorContext, input: z.infer<typeof pciCaseSourcePrepareRequestSchema>['input'], idempotencyKey: string) {
    const source = fixedPciSource()
    return this.commands.execute({ context, input, idempotencyKey, idempotencyScope: 'workspace',
      operation: 'synthetic-case.pci-source.prepare', expectedVersions: {}, dataSchema: pciCaseSourceSchema,
      authorize: () => {
        if (context.roleCode !== 'administrator') throw new PciCaseSourceError('ROLE_NOT_ALLOWED', '只有管理员可以准备固定 PCI 病例来源', 403)
        if (input.expectedEpoch !== context.epoch) throw new PciCaseSourceError('PCI_SOURCE_EPOCH_CONFLICT', '病例来源准备意图所属数据世代已变化', 409)
      },
    }, () => {
      const profile = createSyntheticPatientProfiles({ batchId: `${pciDataPackage.id}:${pciDataPackage.version}:case-source`,
        batchName: '固定 PCI 黄金病例来源', createdAt: new Date().toISOString(), sources: [source], workspaceId: context.workspaceId,
        authoring: { packageId: pciDataPackage.id, packageVersion: pciDataPackage.version, draftId: pciDataPackage.caseDraft.id },
      })[0]!
      const existing = this.cases.getByProfileRevision(context.workspaceId, profile.profileId, profile.revision)
      if (existing !== undefined && existing.status !== 'retired') return {
        data: { case: existing, profileId: profile.profileId, sourceHash: source.hash, packageVersion: pciDataPackage.version }, effects: [],
      }
      this.profiles.createBatch([profile], context.actorId)
      const syntheticCase = existing === undefined
        ? this.cases.createFromProfile({ actorId: context.actorId, profile, compiled: compileSyntheaIndexCase(source.raw) })
        : this.cases.restoreRetired(context.workspaceId, existing.caseId, new Date().toISOString())
      return { data: { case: syntheticCase, profileId: profile.profileId, sourceHash: source.hash, packageVersion: pciDataPackage.version },
        effects: [{ kind: existing === undefined ? 'created' as const : 'updated' as const, reference: `SyntheticPatientProfile/${profile.profileId}`, versionId: String(profile.revision) },
          { kind: existing === undefined ? 'created' as const : 'updated' as const, reference: `SyntheticCase/${syntheticCase.caseId}`, versionId: String(syntheticCase.revision) }],
      }
    })
  }
}
