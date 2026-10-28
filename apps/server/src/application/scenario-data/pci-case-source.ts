import { pciCaseSourceSchema, type pciCaseSourcePrepareRequestSchema } from '@clinmesh/contracts/inpatient-pci-data'
import type { z } from 'zod'
import type { ActorContext, CommandEffect, CommandExecutor } from '../command-executor.ts'
import type { PatientPersonaRepository } from '../../infrastructure/sqlite/patient-persona-repository.ts'
import type { SyntheticCaseRepository } from '../../infrastructure/sqlite/synthetic-case-repository.ts'
import type { SyntheticPatientProfileRepository } from '../../infrastructure/sqlite/synthetic-patient-profile-repository.ts'
import { createSyntheticPatientProfiles } from './synthetic-patient-profile.ts'
import { compileSyntheaIndexCase } from './synthea-index-case.ts'
import { canonicalJsonHash } from './canonical-json.ts'
import { pciDataPackage } from './pci-data.ts'
import { pciPatientPersonaTemplate } from './pci-patient-persona.ts'

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
  constructor(readonly commands: CommandExecutor, readonly profiles: SyntheticPatientProfileRepository, readonly cases: SyntheticCaseRepository, readonly personas: PatientPersonaRepository) {}

  prepare(context: ActorContext, input: z.infer<typeof pciCaseSourcePrepareRequestSchema>['input'], idempotencyKey: string) {
    const source = fixedPciSource()
    return this.commands.execute({ context, input, idempotencyKey, idempotencyScope: 'workspace',
      operation: 'synthetic-case.pci-source.prepare', expectedVersions: {}, dataSchema: pciCaseSourceSchema,
      authorize: () => {
        if (context.roleCode !== 'administrator') throw new PciCaseSourceError('ROLE_NOT_ALLOWED', '只有管理员可以准备固定 PCI 病例来源', 403)
        if (input.expectedEpoch !== context.epoch) throw new PciCaseSourceError('PCI_SOURCE_EPOCH_CONFLICT', '病例来源准备意图所属数据世代已变化', 409)
      },
    }, () => {
      const fixedProfile = createSyntheticPatientProfiles({ batchId: `${pciDataPackage.id}:${pciDataPackage.version}:case-source`,
        batchName: '固定 PCI 黄金病例来源', createdAt: new Date().toISOString(), sources: [source], workspaceId: context.workspaceId,
        authoring: { packageId: pciDataPackage.id, packageVersion: pciDataPackage.version, draftId: pciDataPackage.caseDraft.id },
      })[0]!
      let syntheticCase = this.cases.getByProfile(context.workspaceId, fixedProfile.profileId)
      const created = syntheticCase === undefined
      const effects: CommandEffect[] = []
      if (syntheticCase === undefined) {
        const restored = this.profiles.createBatch([fixedProfile], context.actorId)
        let profile = this.profiles.get(context.workspaceId, fixedProfile.profileId)!
        const retired = this.cases.getByProfileRevision(context.workspaceId, profile.profileId, profile.revision)
        if (retired !== undefined) {
          profile = { ...profile, revision: profile.revision + 1, updatedAt: new Date().toISOString() }
          if (!this.profiles.update(profile, profile.revision - 1, context.actorId)) throw new PciCaseSourceError('PCI_SOURCE_REVISION_CONFLICT', '固定病例档案修订已变化', 409)
        }
        syntheticCase = this.cases.createFromProfile({ actorId: context.actorId, profile, compiled: compileSyntheaIndexCase(source.raw) })
        effects.push({ kind: restored.length === 0 && retired === undefined ? 'created' : 'updated', reference: `SyntheticPatientProfile/${profile.profileId}`, versionId: String(profile.revision) })
      }
      // 已选用或已消费的病例保持原样；旧版未选用的人工修订优先于模板。
      if (syntheticCase.activeBriefRevision === null && syntheticCase.status === 'brief-pending') {
        const now = new Date().toISOString()
        let persona = this.personas.listRevisions(context.workspaceId, syntheticCase.caseId)!.items[0]
        if (persona === undefined) {
          persona = this.personas.createRevision({
            workspaceId: context.workspaceId, caseId: syntheticCase.caseId, createdAt: now,
            content: pciPatientPersonaTemplate.content, model: 'clinmesh-authored-template',
            promptVersion: pciPatientPersonaTemplate.version, promptHash: canonicalJsonHash(pciPatientPersonaTemplate),
            inputHash: canonicalJsonHash({ sourceHash: source.hash, authoring: fixedProfile.source.authoring }),
            outputHash: canonicalJsonHash(pciPatientPersonaTemplate.content),
          })
          effects.push({ kind: 'created', reference: `PatientPersona/${syntheticCase.caseId}/${persona.revision}`, versionId: String(persona.revision) })
        }
        const selected = this.personas.selectRevision({
          workspaceId: context.workspaceId, caseId: syntheticCase.caseId, now,
          personaRevision: persona.revision, expectedCaseRevision: syntheticCase.revision,
        })
        if (selected === undefined) throw new PciCaseSourceError('PCI_SOURCE_REVISION_CONFLICT', '固定病例档案修订已变化', 409)
        syntheticCase = selected
        effects.push({ kind: created ? 'created' : 'updated', reference: `SyntheticCase/${syntheticCase.caseId}`, versionId: String(syntheticCase.revision) })
      }
      return { data: { case: syntheticCase, profileId: fixedProfile.profileId, sourceHash: source.hash, packageVersion: pciDataPackage.version }, effects }
    })
  }
}
