import { z } from 'zod'
import { syntheticInpatientSurgeryCatalog } from './scenario-data/inpatient-surgery-catalog.ts'
import type { createHospitalBaseline } from './scenario-data/hospital-baseline.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository, RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'
import { syntheticAccounts } from './identity-service.ts'

export function seedInpatientEnvironment(database: ClinMeshDatabase, fhir: FhirRepository, context: RepositoryContext, medications: ReturnType<typeof createHospitalBaseline>['catalog']['medications']) {
  const existingSurgeryItems = new Set(z.array(z.object({ item_id: z.string() })).parse(database.driver.prepare(
    'SELECT item_id FROM inpatient_surgery_catalog WHERE workspace_id=? AND epoch=?').all(context.workspaceId, context.epoch)).map(row => row.item_id))
  for (const [kind, items] of [['procedure', syntheticInpatientSurgeryCatalog.procedures], ['material', syntheticInpatientSurgeryCatalog.materials]] as const) {
    for (const item of items) if (!existingSurgeryItems.has(item.id)) database.driver.prepare(`INSERT INTO inpatient_surgery_catalog VALUES(?,?,?,?,?,?)
      ON CONFLICT(workspace_id,epoch,item_id) DO NOTHING`).run(context.workspaceId, context.epoch, item.id, kind, item.version, JSON.stringify(item))
  }
  for (const medication of medications) {
    database.driver.prepare(`UPDATE outpatient_catalog SET config_json=json_set(config_json,
      '$.availableScopes',json('["outpatient","inpatient"]'),'$.unit',?,'$.inpatientDoses',json(?),'$.inpatientBillingTrigger','dispense')
      WHERE workspace_id=? AND epoch=? AND item_id=? AND json_type(config_json,'$.inpatientDoses') IS NULL`)
      .run(medication.unit, JSON.stringify([{ doseText: medication.defaultDose, quantity: 1 }]), context.workspaceId, context.epoch, medication.id)
  }
  // 合成本院有界规则；编码身份取自锁定临床版，不据此宣称通用临床适应症。
  for (const [medicationId, code, row] of [['medication-amlodipine','I10.x09',12457],['medication-metformin','E11.900',7261],['medication-acetaminophen','R50.900',27266]] as const) {
    database.driver.prepare(`UPDATE outpatient_catalog SET config_json=json_set(config_json,'$.inpatientIndications',json(?))
      WHERE workspace_id=? AND epoch=? AND item_id=? AND json_type(config_json,'$.inpatientIndications') IS NULL`).run(JSON.stringify([{ id: `nhsa-diagnosis:nhc-icd10-clinical@2022.r4:${code}`,
        system: 'urn:clinmesh:reference:nhsa-diagnosis', version: '2022', code, sourceLocator: `cn-health:nhc-icd10-clinical@2022.r4:diagnosis:${row}` }]), context.workspaceId, context.epoch, medicationId)
  }
  database.driver.prepare(`UPDATE hospital_service_catalog SET config_json=json_set(config_json,
    '$.availableScopes',json('["outpatient","inpatient"]'),'$.inpatientBillingTrigger','execution')
    WHERE workspace_id=? AND epoch=? AND service_id='hospital-service-diabetes-education' AND json_type(config_json,'$.inpatientBillingTrigger') IS NULL`)
    .run(context.workspaceId, context.epoch)
  const exists = (type: string, id: string) => database.driver.prepare(`
    SELECT 1 FROM fhir_resource WHERE workspace_id=? AND epoch=? AND resource_type=? AND resource_id=? AND deleted=0`)
    .get(context.workspaceId, context.epoch, type, id) !== undefined
  for (const account of syntheticAccounts.filter(account => ['inpatient-doctor', 'ward-nurse', 'medical-records'].includes(account.roleCode))) {
    if (!exists('Practitioner', account.practitionerId)) fhir.create(context, {
      resourceType: 'Practitioner', id: account.practitionerId, active: true, name: [{ text: account.name }],
    })
    if (account.roleCode === 'medical-records' && !exists('Location', `location-${account.roleCode}`)) fhir.create(context, {
      resourceType: 'Location', id: `location-${account.roleCode}`, status: 'active', name: `${account.name}工作区`,
      managingOrganization: { reference: 'Organization/organization-clinmesh' },
    })
    if (account.roleCode === 'medical-records' && !exists('PractitionerRole', 'practitioner-role-medical-records')) fhir.create(context, {
      resourceType: 'PractitionerRole', id: 'practitioner-role-medical-records', active: true,
      practitioner: { reference: `Practitioner/${account.practitionerId}` }, organization: { reference: 'Organization/organization-clinmesh' },
      code: [{ text: 'medical-records' }], location: [{ reference: 'Location/location-medical-records' }],
    })
  }
  for (const [suffix, name, department] of [['general', '内科病区', 'medicine'], ['surgery', '外科病区', 'surgery']] as const) {
    const wardId = `ward-${suffix}`
    if (database.driver.prepare('SELECT 1 FROM inpatient_ward WHERE workspace_id=? AND epoch=? AND ward_id=?')
      .get(context.workspaceId, context.epoch, wardId) !== undefined) continue
    const organizationId = `organization-inpatient-${department}`
    fhir.create(context, { resourceType: 'Organization', id: organizationId, active: true,
      name: suffix === 'general' ? '合成住院内科' : '合成住院外科', partOf: { reference: 'Organization/organization-clinmesh' } })
    fhir.create(context, { resourceType: 'Location', id: wardId, status: 'active', name,
      managingOrganization: { reference: `Organization/${organizationId}` },
      form: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'wa' }] } })
    database.driver.prepare('INSERT INTO inpatient_ward VALUES (?, ?, ?, ?, ?)')
      .run(context.workspaceId, context.epoch, wardId, organizationId, name)
    const roomId = `room-${suffix}-101`
    fhir.create(context, { resourceType: 'Location', id: roomId, status: 'active', name: `${name}101室`,
      partOf: { reference: `Location/${wardId}` }, managingOrganization: { reference: `Organization/${organizationId}` },
      form: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'ro' }] } })
    for (const number of [1, 2, 3]) {
      const bedId = `bed-${suffix}-${number}`
      fhir.create(context, { resourceType: 'Location', id: bedId, status: 'active', name: `${name}${number}床`,
        partOf: { reference: `Location/${roomId}` }, managingOrganization: { reference: `Organization/${organizationId}` },
        form: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'bd' }] } })
      database.driver.prepare('INSERT INTO inpatient_bed VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(context.workspaceId, context.epoch, bedId, wardId, roomId, `${number}床`, 5000)
    }
    for (const roleCode of ['inpatient-doctor', 'ward-nurse']) {
      const roleId = `practitioner-role-${roleCode}${suffix === 'general' ? '' : '-surgery'}`
      const resource = { resourceType: 'PractitionerRole', id: roleId, active: true,
        practitioner: { reference: `Practitioner/practitioner-${roleCode}` },
        organization: { reference: `Organization/${organizationId}` }, code: [{ text: roleCode }],
        location: [{ reference: `Location/${wardId}` }] }
      fhir.create(context, resource)
    }
  }
}
