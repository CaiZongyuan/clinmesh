import { z } from 'zod'
import { SURGICAL_LOCATIONS } from '@clinmesh/core/inpatient-surgery-consent'
import { CLASS_A_COVERAGE } from './catalog-insurance-coverage.ts'
import { syntheticInpatientSurgeryCatalog } from './scenario-data/inpatient-surgery-catalog.ts'
import { storeMaterialSnapshot } from './scenario-data/cardiovascular-materials.ts'
import { standardMedicationPackageInsert } from './scenario-data/medication-package-inserts.ts'
import { standardMedicationDoseBasis, standardMedicationRoutes, standardMedicationSafety } from './scenario-data/standard-medications.ts'
import type { createHospitalBaseline } from './scenario-data/hospital-baseline.ts'
import type { ClinMeshDatabase } from '../infrastructure/sqlite/database.ts'
import type { FhirRepository, RepositoryContext } from '../infrastructure/sqlite/fhir-repository.ts'
import { syntheticAccounts } from './identity-service.ts'

const SURGICAL_LIDOCAINE_PRODUCT = {
  id: 'synthetic-medication-product-surgical-lidocaine',
  code: 'CM-NHSA-PRODUCT-SURGICAL-LIDOCAINE',
  system: 'urn:clinmesh:reference:nhsa-medication-product',
  version: 'clinmesh-synthetic-medications-2026-11-24',
  approvalNumber: 'CM-SYNTHETIC-SURGICAL-LIDOCAINE',
  brandName: null,
  dosageForm: '注射剂',
  genericName: '盐酸利多卡因注射液',
  manufacturer: 'ClinMesh 仿真制药一厂',
  packageDescription: '5mL:100mg×5支/盒',
  strength: '5 mL:100 mg',
} as const

const INTRAOPERATIVE_NURSING_SERVICES = [
  {
    serviceId: 'hospital-service-intraoperative-interventional-nursing',
    code: 'HOSP-SVC-INTRAOP-INTERVENTIONAL-NURSING',
    nameZh: '术中介入专科护理',
    nameEn: 'Intraoperative Interventional Specialty Nursing',
    executingDepartmentId: 'location-catheterization-lab',
    priceFen: 8000,
    procedureIds: [
      'hospital-surgery-1',
      'hospital-surgery-2',
      'hospital-surgery-3',
      'hospital-surgery-7',
      'hospital-surgery-8',
    ],
  },
  {
    serviceId: 'hospital-service-intraoperative-surgical-nursing',
    code: 'HOSP-SVC-INTRAOP-SURGICAL-NURSING',
    nameZh: '术中手术室专科护理',
    nameEn: 'Intraoperative Operating Room Specialty Nursing',
    executingDepartmentId: 'location-operating-center',
    priceFen: 10000,
    procedureIds: ['hospital-surgery-5'],
  },
] as const

const POSTOPERATIVE_WARD_NURSING_SERVICES = [
  {
    serviceId: 'hospital-service-postop-ecg-monitoring',
    code: 'HOSP-SVC-POSTOP-ECG-MONITORING',
    nameZh: '术后持续心电监护',
    nameEn: 'Postoperative Continuous ECG Monitoring',
    priceFen: 6000,
    reportTemplate: '病房护士执行术后持续心电、血压、血氧监护并记录病情观察。',
  },
  {
    serviceId: 'hospital-service-postop-puncture-immobilization',
    code: 'HOSP-SVC-POSTOP-PUNCTURE-IMMOBILIZATION',
    nameZh: '穿刺部位压迫止血与肢体制动护理',
    nameEn: 'Post-PCI Puncture Site Compression and Limb Immobilization Nursing',
    priceFen: 4000,
    reportTemplate: '病房护士观察穿刺点渗血、血肿及远端动脉搏动，规范压迫止血与肢体制动护理。',
  },
  {
    serviceId: 'hospital-service-postop-wound-vital-nursing',
    code: 'HOSP-SVC-POSTOP-WOUND-VITAL-NURSING',
    nameZh: '术后常规切口与生命体征护理',
    nameEn: 'Postoperative Routine Wound and Vital Signs Nursing',
    priceFen: 3500,
    reportTemplate: '病房护士观察手术切口敷料、引流及生命体征，落实术后常规病房护理。',
  },
] as const

export function backfillMedicationPackageInserts(database: ClinMeshDatabase, context: RepositoryContext) {
  const missing = z.array(z.object({ item_id: z.string() })).parse(database.driver.prepare(`
    SELECT item_id FROM outpatient_catalog
    WHERE workspace_id=? AND epoch=? AND kind='medication' AND json_type(config_json,'$.packageInsert') IS NULL
  `).all(context.workspaceId, context.epoch))
  if (missing.length === 0) return
  const update = database.driver.prepare(`
    UPDATE outpatient_catalog SET config_json=json_set(config_json,'$.packageInsert',json(?))
    WHERE workspace_id=? AND epoch=? AND item_id=? AND kind='medication' AND json_type(config_json,'$.packageInsert') IS NULL
  `)
  for (const { item_id } of missing) {
    const packageInsert = standardMedicationPackageInsert(item_id)
    if (packageInsert) update.run(JSON.stringify(packageInsert), context.workspaceId, context.epoch, item_id)
  }
}

export function seedInpatientEnvironment(
  database: ClinMeshDatabase,
  fhir: FhirRepository,
  context: RepositoryContext,
  medications: ReturnType<typeof createHospitalBaseline>['catalog']['medications'],
  options?: { skipPackageInsertBackfill?: boolean },
) {
  if (!options?.skipPackageInsertBackfill) backfillMedicationPackageInserts(database, context)
  const existingSurgeryItems = new Set(z.array(z.object({ item_id: z.string() })).parse(database.driver.prepare(
    'SELECT item_id FROM inpatient_surgery_catalog WHERE workspace_id=? AND epoch=?').all(context.workspaceId, context.epoch)).map(row => row.item_id))
  for (const [kind, items] of [['procedure', syntheticInpatientSurgeryCatalog.procedures], ['material', syntheticInpatientSurgeryCatalog.materials.map(storeMaterialSnapshot)]] as const) {
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
  const lidocaineConfig = {
    availableScopes: ['surgical-base'],
    surgicalBaseStock: true,
    unit: 'mL',
    dose: '5 mL',
    frequency: 'ONCE',
    route: '注射',
    ...standardMedicationRoutes('medication-surgical-lidocaine')!,
    product: SURGICAL_LIDOCAINE_PRODUCT,
    inpatientDoses: [
      { doseText: '5 mL', quantity: 5 },
      { doseText: '100 mg', quantity: 5 },
    ],
    inpatientDoseBasis: standardMedicationDoseBasis('medication-surgical-lidocaine')!,
    inpatientMaxDoseQuantity: 20,
    allowedFrequencyCodes: ['ONCE'],
    allowedCombinationIds: [],
    inpatientBillingTrigger: 'dispense',
    insuranceCoverage: CLASS_A_COVERAGE,
    safety: standardMedicationSafety('medication-surgical-lidocaine')!,
    packageInsert: standardMedicationPackageInsert('medication-surgical-lidocaine')!,
  }
  database.driver.prepare(`
    INSERT INTO outpatient_catalog(workspace_id,epoch,item_id,kind,code,name_zh,name_en,price_fen,version,active,config_json)
    VALUES(?,?,'medication-surgical-lidocaine','medication','SURGICAL-LIDOCAINE','盐酸利多卡因注射液','Lidocaine Hydrochloride Injection',120,1,1,?)
    ON CONFLICT(workspace_id,epoch,item_id) DO NOTHING
  `).run(context.workspaceId, context.epoch, JSON.stringify(lidocaineConfig))
  database.driver.prepare(`
    UPDATE outpatient_catalog SET config_json=json_set(config_json,'$.surgicalBaseStock',json('true'))
    WHERE workspace_id=? AND epoch=? AND kind='medication'
      AND item_id IN ('medication-pci-heparin','medication-nitroglycerin','medication-sodium-chloride','medication-pci-iohexol')
      AND json_type(config_json,'$.surgicalBaseStock') IS NULL
  `).run(context.workspaceId, context.epoch)
  for (const nursing of INTRAOPERATIVE_NURSING_SERVICES) {
    const config = {
      availableScopes: ['inpatient'],
      billingUnit: {
        code: 'SESSION',
        display: '次',
        system: 'urn:clinmesh:wst:billing-unit',
        valueSet: 'urn:clinmesh:wst:value-set:billing-unit',
        version: 'synthetic-surgery-nursing-2026-11-24',
      },
      category: {
        code: 'NURSING',
        display: '专科护理',
        system: 'urn:clinmesh:wst:service-category',
        valueSet: 'urn:clinmesh:wst:value-set:service-category',
        version: 'synthetic-surgery-nursing-2026-11-24',
      },
      chargeDefinition: {
        id: `charge-definition-${nursing.serviceId}`,
        currency: 'CNY',
        effectiveOn: '2026-11-24',
        priceFen: nursing.priceFen,
      },
      componentServiceIds: [],
      executingDepartmentId: nursing.executingDepartmentId,
      insuranceCoverage: CLASS_A_COVERAGE,
      nationalService: {
        code: 'CM-NHC-SERVICE-SURGICAL-NURSING',
        display: '合成术中专科护理服务',
        id: `reference-service-${nursing.serviceId}`,
        system: 'urn:clinmesh:reference:nhc-medical-service',
        version: 'synthetic-2026-11-24',
      },
      reportTemplate: `${nursing.nameZh}随对应术式完成自动联动计费。`,
      requestCatalogItemIds: [],
      tatMinutes: 30,
      inpatientBillingTrigger: 'surgery-completion',
      surgicalProcedureIds: [...nursing.procedureIds],
    }
    database.driver.prepare(`
      INSERT INTO hospital_service_catalog(workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json)
      VALUES(?,?,?,?,?,?,1,1,?)
      ON CONFLICT(workspace_id,epoch,service_id) DO NOTHING
    `).run(context.workspaceId, context.epoch, nursing.serviceId, nursing.code, nursing.nameZh, nursing.nameEn, JSON.stringify(config))
  }
  for (const nursing of POSTOPERATIVE_WARD_NURSING_SERVICES) {
    const config = {
      availableScopes: ['inpatient'],
      billingUnit: {
        code: 'SESSION',
        display: '次',
        system: 'urn:clinmesh:wst:billing-unit',
        valueSet: 'urn:clinmesh:wst:value-set:billing-unit',
        version: 'synthetic-postop-ward-nursing-2026-11-25',
      },
      category: {
        code: 'NURSING',
        display: '病房护理',
        system: 'urn:clinmesh:wst:service-category',
        valueSet: 'urn:clinmesh:wst:value-set:service-category',
        version: 'synthetic-postop-ward-nursing-2026-11-25',
      },
      chargeDefinition: {
        id: `charge-definition-${nursing.serviceId}`,
        currency: 'CNY',
        effectiveOn: '2026-11-25',
        priceFen: nursing.priceFen,
      },
      componentServiceIds: [],
      executingDepartmentId: 'ward-general',
      insuranceCoverage: CLASS_A_COVERAGE,
      nationalService: {
        code: 'CM-NHC-SERVICE-POSTOP-WARD-NURSING',
        display: '合成术后病房护理服务',
        id: `reference-service-${nursing.serviceId}`,
        system: 'urn:clinmesh:reference:nhc-medical-service',
        version: 'synthetic-2026-11-25',
      },
      reportTemplate: nursing.reportTemplate,
      requestCatalogItemIds: [],
      tatMinutes: 30,
      inpatientBillingTrigger: 'execution',
    }
    database.driver.prepare(`
      INSERT INTO hospital_service_catalog(workspace_id,epoch,service_id,code,name_zh,name_en,version,active,config_json)
      VALUES(?,?,?,?,?,?,1,1,?)
      ON CONFLICT(workspace_id,epoch,service_id) DO NOTHING
    `).run(context.workspaceId, context.epoch, nursing.serviceId, nursing.code, nursing.nameZh, nursing.nameEn, JSON.stringify(config))
  }
  const exists = (type: string, id: string) => database.driver.prepare(`
    SELECT 1 FROM fhir_resource WHERE workspace_id=? AND epoch=? AND resource_type=? AND resource_id=? AND deleted=0`)
    .get(context.workspaceId, context.epoch, type, id) !== undefined
  const hasResourceRow = (type: string, id: string) => database.driver.prepare(`
    SELECT 1 FROM fhir_resource WHERE workspace_id=? AND epoch=? AND resource_type=? AND resource_id=?`)
    .get(context.workspaceId, context.epoch, type, id) !== undefined
  if (!hasResourceRow('Medication', 'medication-surgical-lidocaine')) {
    fhir.create(context, {
      resourceType: 'Medication',
      id: 'medication-surgical-lidocaine',
      status: 'active',
      code: {
        coding: [{
          system: SURGICAL_LIDOCAINE_PRODUCT.system,
          version: SURGICAL_LIDOCAINE_PRODUCT.version,
          code: SURGICAL_LIDOCAINE_PRODUCT.code,
          display: SURGICAL_LIDOCAINE_PRODUCT.genericName,
        }],
        text: SURGICAL_LIDOCAINE_PRODUCT.genericName,
      },
    })
  }
  for (const account of syntheticAccounts.filter(account => ['inpatient-doctor', 'ward-nurse', 'medical-records', 'medical-insurance'].includes(account.roleCode))) {
    if (!hasResourceRow('Practitioner', account.practitionerId)) fhir.create(context, {
      resourceType: 'Practitioner', id: account.practitionerId, active: true, name: [{ text: account.name }],
    })
    if (['medical-records', 'medical-insurance'].includes(account.roleCode) && !hasResourceRow('Location', `location-${account.roleCode}`)) fhir.create(context, {
      resourceType: 'Location', id: `location-${account.roleCode}`, status: 'active', name: `${account.name}工作区`,
      managingOrganization: { reference: 'Organization/organization-clinmesh' },
    })
    if (['medical-records', 'medical-insurance'].includes(account.roleCode) && !hasResourceRow('PractitionerRole', `practitioner-role-${account.roleCode}`)) fhir.create(context, {
      resourceType: 'PractitionerRole', id: `practitioner-role-${account.roleCode}`, active: true,
      practitioner: { reference: `Practitioner/${account.practitionerId}` }, organization: { reference: 'Organization/organization-clinmesh' },
      code: [{ text: account.roleCode }], location: [{ reference: `Location/location-${account.roleCode}` }],
    })
  }
  for (const surgicalLocation of SURGICAL_LOCATIONS) {
    if (!hasResourceRow('Location', surgicalLocation.id)) fhir.create(context, {
      resourceType: 'Location', id: surgicalLocation.id, status: 'active', name: surgicalLocation.name,
      managingOrganization: { reference: 'Organization/organization-clinmesh' },
      form: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/location-physical-type', code: 'ro' }] },
    })
  }
  for (const [surgeonId, surgeonName, title] of [
    ['practitioner-surgeon-chief', '林海', '主任医师'],
    ['practitioner-surgeon-attending', '陈铭', '主治医师'],
  ] as const) {
    if (!hasResourceRow('Practitioner', surgeonId)) fhir.create(context, {
      resourceType: 'Practitioner', id: surgeonId, active: true,
      name: [{ text: surgeonName }],
      qualification: [{ code: { text: title } }],
    })
  }
  for (const [suffix, name, department] of [['general', '住院病区', 'medicine']] as const) {
    const wardId = `ward-${suffix}`
    if (database.driver.prepare('SELECT 1 FROM inpatient_ward WHERE workspace_id=? AND epoch=? AND ward_id=?')
      .get(context.workspaceId, context.epoch, wardId) !== undefined) {
      // 仅升级原默认显示名；稳定引用、自定义名称和临床事实保持原样。
      for (const [type, id, oldName, newName] of [
        ['Organization', 'organization-inpatient-medicine', '合成住院内科', '住院科'],
        ['Location', wardId, '内科病区', name],
        ['Location', 'room-general-101', '内科病区101室', `${name}101室`],
        ...[1, 2, 3].map(number => ['Location', `bed-general-${number}`, `内科病区${number}床`, `${name}${number}床`] as const),
      ] as const) {
        if (!exists(type, id)) continue
        const resource = fhir.read(context, type, id)
        if (resource.name === oldName) fhir.update(context, { ...resource, name: newName }, resource.meta!.versionId!)
      }
      database.driver.prepare('UPDATE inpatient_ward SET name=? WHERE workspace_id=? AND epoch=? AND ward_id=? AND name=?')
        .run(name, context.workspaceId, context.epoch, wardId, '内科病区')
      continue
    }
    const organizationId = `organization-inpatient-${department}`
    fhir.create(context, { resourceType: 'Organization', id: organizationId, active: true,
      name: '住院科', partOf: { reference: 'Organization/organization-clinmesh' } })
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
