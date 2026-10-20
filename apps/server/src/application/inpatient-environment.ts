import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository, RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'

export function seedInpatientEnvironment(database: ClinMeshDatabase, fhir: FhirRepository, context: RepositoryContext) {
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
      if (suffix === 'general') {
        const existing = fhir.read(context, 'PractitionerRole', roleId)
        fhir.update(context, resource, existing.meta!.versionId!)
      } else fhir.create(context, resource)
    }
  }
}
