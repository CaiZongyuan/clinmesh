import { z } from 'zod'
import type { createClinMeshRuntime } from '../../src/runtime.ts'

/** 显式安排旧双病区环境；生产默认环境只包含一个住院科、一个病区。 */
export async function addSecondaryInpatientWard(runtime: Awaited<ReturnType<typeof createClinMeshRuntime>>): Promise<void> {
  const context = z.object({ workspaceId: z.string(), epoch: z.string() }).parse(runtime.database.driver.prepare(
    'SELECT workspace_id workspaceId, active_epoch epoch FROM workspace WHERE workspace_id=?').get('workspace-demo'))
  const { database, fhir } = runtime
  database.driver.exec('BEGIN IMMEDIATE')
  try {
    if (database.driver.prepare('SELECT 1 FROM inpatient_ward WHERE workspace_id=? AND epoch=? AND ward_id=?')
      .get(context.workspaceId, context.epoch, 'ward-surgery') === undefined) {
      fhir.create(context, { resourceType: 'Organization', id: 'organization-inpatient-surgery', active: true,
        name: '合成住院外科', partOf: { reference: 'Organization/organization-clinmesh' } })
      fhir.create(context, { resourceType: 'Location', id: 'ward-surgery', status: 'active', name: '外科病区',
        managingOrganization: { reference: 'Organization/organization-inpatient-surgery' },
        form: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'wa' }] } })
      database.driver.prepare('INSERT INTO inpatient_ward VALUES (?, ?, ?, ?, ?)')
        .run(context.workspaceId, context.epoch, 'ward-surgery', 'organization-inpatient-surgery', '外科病区')
      fhir.create(context, { resourceType: 'Location', id: 'room-surgery-101', status: 'active', name: '外科病区101室',
        partOf: { reference: 'Location/ward-surgery' }, managingOrganization: { reference: 'Organization/organization-inpatient-surgery' },
        form: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'ro' }] } })
      for (const number of [1, 2, 3]) {
        const bedId = `bed-surgery-${number}`
        fhir.create(context, { resourceType: 'Location', id: bedId, status: 'active', name: `外科病区${number}床`,
          partOf: { reference: 'Location/room-surgery-101' }, managingOrganization: { reference: 'Organization/organization-inpatient-surgery' },
          form: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'bd' }] } })
        database.driver.prepare('INSERT INTO inpatient_bed VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(context.workspaceId, context.epoch, bedId, 'ward-surgery', 'room-surgery-101', `${number}床`, 5000)
      }
      for (const roleCode of ['inpatient-doctor', 'ward-nurse']) fhir.create(context, {
        resourceType: 'PractitionerRole', id: `practitioner-role-${roleCode}-surgery`, active: true,
        practitioner: { reference: `Practitioner/practitioner-${roleCode}` },
        organization: { reference: 'Organization/organization-inpatient-surgery' }, code: [{ text: roleCode }],
        location: [{ reference: 'Location/ward-surgery' }],
      })
    }
    for (const roleCode of ['inpatient-doctor', 'ward-nurse']) {
      const roleId = `practitioner-role-${roleCode}-surgery`
      database.driver.prepare(`INSERT OR IGNORE INTO practitioner_role_binding
        (workspace_id, practitioner_role_id, practitioner_id, role_code, organization_id, location_id, active)
        VALUES (?, ?, ?, ?, 'organization-inpatient-surgery', 'ward-surgery', 1)`)
        .run(context.workspaceId, roleId, `practitioner-${roleCode}`, roleCode)
      for (const membership of [`membership-${roleCode}`, 'membership-administrator']) database.driver.prepare(
        'INSERT OR IGNORE INTO membership_practitioner_role VALUES (?, ?, ?)').run(membership, context.workspaceId, roleId)
    }
    database.driver.exec('COMMIT')
  } catch (error) {
    database.driver.exec('ROLLBACK')
    throw error
  }
}
