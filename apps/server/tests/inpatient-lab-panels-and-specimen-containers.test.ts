import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { getHisOperation } from '@clinmesh/contracts/his-operations'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import {
  inpatientInvestigationCatalogSchema,
  inpatientInvestigationResponseSchema,
} from '@clinmesh/contracts/inpatient-investigations'
import {
  inpatientPciDataResponseSchema,
  pciCaseSourceResponseSchema,
  startSyntheticInpatientCaseResponseSchema,
} from '@clinmesh/contracts/inpatient-pci-data'
import { classifyInpatientLaboratoryCategory } from '../src/application/inpatient-laboratory-category.ts'
import { defaultSyntheticLaboratoryPriceFen } from '../src/application/outpatient-investigation-billing.ts'
import { runReferenceDatabaseCli } from '../src/reference-database-cli.ts'
import { createClinMeshRuntime } from '../src/runtime.ts'

const panelSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/laboratory-panel-cn'
const wstSystem = 'https://caizongyuan.github.io/clinmesh/fhir/CodeSystem/wst-886-2026'
const ruleMeta = {
  notes: '成人参考范围',
  sourceLocation: 'WS/T 886-2026 表1',
  sourceStandard: 'WS/T 886-2026',
  sourceType: 'national-standard' as const,
  sourceVersion: '2026',
}

function quantTest(code: string, display: string, specimen: string, unit: string, low: number, high: number) {
  const conceptId = `wst-886:2026:${code}`
  return {
    concept: {
      code,
      display,
      domain: 'laboratory' as const,
      id: conceptId,
      sourceLocator: `synthetic:test:${code}`,
      status: 'active' as const,
      system: wstSystem,
      version: '2026',
    },
    definition: {
      adultReferenceRules: [{
        high,
        low,
        referenceKind: 'range' as const,
        sex: 'all' as const,
        simulationHigh: high,
        simulationLow: low,
        ...ruleMeta,
      }],
      alternateCodings: [],
      analyte: display,
      category: '合成检验',
      conceptId,
      datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
      healthyStrategy: 'uniform' as const,
      kind: 'laboratory-cn-test' as const,
      precision: 1,
      resultKind: 'quantity' as const,
      scale: '定量' as const,
      sourceLocator: `synthetic:test:${code}`,
      sourceVersion: '2026',
      specimen,
      unit: { code: unit, display: unit, system: 'http://unitsofmeasure.org' as const },
    },
  }
}

function qualTest(code: string, display: string, specimen: string) {
  const conceptId = `wst-886:2026:${code}`
  return {
    concept: {
      code,
      display,
      domain: 'laboratory' as const,
      id: conceptId,
      sourceLocator: `synthetic:test:${code}`,
      status: 'active' as const,
      system: wstSystem,
      version: '2026',
    },
    definition: {
      adultReferenceRules: [{
        normalValue: '阴性(-)',
        referenceKind: 'ordinal' as const,
        sex: 'all' as const,
        ...ruleMeta,
      }],
      alternateCodings: [],
      analyte: display,
      category: '合成检验',
      conceptId,
      datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
      healthyStrategy: 'fixed-normal' as const,
      kind: 'laboratory-cn-test' as const,
      precision: 0,
      resultKind: 'ordinal' as const,
      scale: '半定量',
      sourceLocator: `synthetic:test:${code}`,
      sourceVersion: '2026',
      specimen,
    },
  }
}

function panelItem(code: string, display: string, specimen: string, memberCodes: string[]) {
  const conceptId = `laboratory-panel-cn:2026-09-01:${code}`
  return {
    concept: {
      code,
      display,
      domain: 'laboratory' as const,
      id: conceptId,
      sourceLocator: `synthetic:panel:${code}`,
      status: 'active' as const,
      system: panelSystem,
      version: '2026-09-01',
    },
    definition: {
      conceptId,
      datasetReleaseId: 'laboratory-cn@2026-09-01.r1',
      kind: 'laboratory-cn-panel' as const,
      notes: display,
      sourceLocation: '检验组合',
      sourceLocator: `synthetic:panel:${code}`,
      sourceType: 'project-authored' as const,
      sourceVersion: '2026-09-01',
      specimen,
    },
    members: memberCodes.map((memberCode, index) => ({
      memberConceptId: `wst-886:2026:${memberCode}`,
      memberOrder: index + 1,
      panelConceptId: conceptId,
      relationship: 'contains' as const,
      sourceLocator: `synthetic:panel:${code}:${index + 1}`,
    })),
  }
}

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe('住院常用检验组合默认定价、目录分类与标本容器投影', () => {
  it('为全部 15 个常用检验组合与全部新增单项提供默认正整数医院价格', () => {
    const all15Panels = [
      'CN-LAB-CBC-5DIFF',
      'CN-LAB-LIVER',
      'CN-LAB-RENAL',
      'CN-LAB-LIVER-RENAL',
      'CN-LAB-ELECTROLYTES',
      'CN-LAB-COAGULATION',
      'CN-LAB-CARDIAC',
      'CN-LAB-LIPIDS',
      'CN-LAB-FASTING-GLUCOSE',
      'CN-LAB-HBA1C',
      'CN-LAB-URINALYSIS',
      'CN-LAB-INFLAMMATION',
      'CN-LAB-THYROID',
      'CN-LAB-HBV-5',
      'CN-LAB-TUMOR-BASIC',
    ]
    for (const code of all15Panels) {
      expect(
        defaultSyntheticLaboratoryPriceFen({ code, system: panelSystem, version: '2026-09-01' }),
        `missing panel price for ${code}`,
      ).toBeGreaterThan(0)
    }

    const newlyPricedTests = [
      '0100901A', '0300101A',
      '0600110D', '0600210D', '0600310D', '0600410D', '0600510D', '0600610D', '0600710B', '0600810D', '0600910D', '0601010D',
      '1100104A', '1100204A', '1101405A', '1101504A', '1102804A',
      '1200604A', '1200704A', '1200804A', '1200904A', '1201004A',
      '1400805A',
      '1500104A', '1500204A', '1500404A', '1500504A', '1500604A', '1500704A', '1500904A', '1501104A', '1501204A',
      '1600104A', '1600204A', '1600604A', '1600704A', '1600804A', '1601504A', '1601604A',
      '1700104A', '1700504A', '1700604A', '1701204A',
      '2400104B', '2400204B', '2400304B', '2400404B', '2400504B',
    ]
    for (const code of newlyPricedTests) {
      expect(
        defaultSyntheticLaboratoryPriceFen({ code, system: wstSystem, version: '2026' }),
        `missing test price for ${code}`,
      ).toBeGreaterThan(0)
    }

    expect(classifyInpatientLaboratoryCategory({ hasPciSupplement: true, referenceCode: '6690-2' })).toBe('preop-routine')
    expect(classifyInpatientLaboratoryCategory({ localCode: 'PCI-LAB-INR', referenceCode: '6301-6' })).toBe('preop-routine')
    expect(classifyInpatientLaboratoryCategory({ referenceCode: 'CN-LAB-CBC-5DIFF' })).toBe('hematology-coagulation')
    expect(classifyInpatientLaboratoryCategory({ referenceCode: '0500103A' })).toBe('hematology-coagulation')
    expect(classifyInpatientLaboratoryCategory({ referenceCode: 'CN-LAB-LIVER' })).toBe('biochemistry')
    expect(classifyInpatientLaboratoryCategory({ referenceCode: '1700404A' })).toBe('biochemistry')
    expect(classifyInpatientLaboratoryCategory({ referenceCode: 'CN-LAB-CARDIAC' })).toBe('cardiac-metabolic')
    expect(classifyInpatientLaboratoryCategory({ referenceCode: 'CN-LAB-HBA1C' })).toBe('cardiac-metabolic')
    expect(classifyInpatientLaboratoryCategory({ referenceCode: 'CN-LAB-URINALYSIS' })).toBe('urinalysis-infection')
    expect(classifyInpatientLaboratoryCategory({ referenceCode: 'CN-LAB-HBV-5' })).toBe('urinalysis-infection')
    expect(classifyInpatientLaboratoryCategory({ referenceCode: 'CN-LAB-THYROID' })).toBe('endocrine-tumor')
    expect(classifyInpatientLaboratoryCategory({ referenceCode: 'CN-LAB-TUMOR-BASIC' })).toBe('endocrine-tumor')
  })

  it('住院检查目录投影组合标识、专科分类与采血管规格，PCI 术前 9 项归入 preop-routine 并冻结容器元数据', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clinmesh-inpatient-lab-tubes-'))
    const referencePath = join(directory, 'reference.sqlite')
    const tests = [
      quantTest('0100101A', '白细胞计数', '全血', '10*9/L', 3.5, 9.5),
      quantTest('0300101A', '红细胞沉降率测定', '全血', 'mm/h', 0, 15),
      quantTest('0500103A', '凝血酶原时间测定', '血浆', 's', 10, 14),
      qualTest('0600310D', '尿蛋白定性试验', '尿液'),
      quantTest('1101405A', 'C反应蛋白测定', '血清、血浆', 'mg/L', 0, 6),
      quantTest('1101504A', '降钙素原测定', '血清、血浆', 'ng/mL', 0, 0.05),
      quantTest('1200604A', '促甲状腺素测定', '血清、血浆', 'mIU/L', 0.35, 4.94),
      quantTest('1500104A', '丙氨酸氨基转移酶测定', '血清、血浆', 'U/L', 9, 50),
      quantTest('1600104A', '甲胎蛋白测定', '血清、血浆', 'ug/L', 0, 7),
      quantTest('1700104A', '葡萄糖测定', '血清、血浆', 'mmol/L', 3.9, 6.1),
      quantTest('1700404A', '肌酐测定', '血清、血浆', 'umol/L', 57, 111),
      qualTest('2400104B', '乙型肝炎病毒表面抗原测定', '血清、血浆'),
    ]
    const panels = [
      panelItem('CN-LAB-CBC-5DIFF', '血常规（五分类）', '全血', ['0100101A']),
      panelItem('CN-LAB-LIVER', '肝功能', '血清、血浆', ['1500104A']),
      panelItem('CN-LAB-LIVER-RENAL', '肝肾功能', '血清、血浆', ['1500104A', '1700404A']),
      panelItem('CN-LAB-COAGULATION', '凝血功能', '血浆', ['0500103A']),
      panelItem('CN-LAB-FASTING-GLUCOSE', '空腹血糖', '血清、血浆', ['1700104A']),
      panelItem('CN-LAB-URINALYSIS', '尿常规', '尿液', ['0600310D']),
      panelItem('CN-LAB-INFLAMMATION', '炎症指标', '混合标本', ['1101405A', '1101504A', '0300101A']),
      panelItem('CN-LAB-THYROID', '甲状腺功能', '血清、血浆', ['1200604A']),
      panelItem('CN-LAB-HBV-5', '乙肝五项', '血清、血浆', ['2400104B']),
      panelItem('CN-LAB-TUMOR-BASIC', '基础肿瘤标志物组合', '血清、血浆', ['1600104A']),
    ]
    const artifactJson = `${JSON.stringify({
      concepts: [...tests.map(item => item.concept), ...panels.map(item => item.concept)],
      laboratoryDefinitions: [...tests.map(item => item.definition), ...panels.map(item => item.definition)],
      laboratoryPanelMembers: panels.flatMap(item => item.members),
      laboratorySpecimens: [],
      laboratoryUnits: [],
      schemaVersion: '1',
    })}\n`
    const manifestPath = join(directory, 'release.json')
    await writeFile(join(directory, 'reference.json'), artifactJson)
    await writeFile(manifestPath, `${JSON.stringify({
      createdAt: '2026-09-02T00:00:00.000Z',
      releaseId: 'lab-tubes-release-v1',
      schemaVersion: '1',
      sources: [{
        acquisitionMethod: 'generated',
        artifactPath: 'reference.json',
        checksum: createHash('sha256').update(artifactJson).digest('hex'),
        licenseId: 'CC0-1.0',
        retrievedAt: '2026-09-02T00:00:00.000Z',
        sourceId: 'cn-health-laboratory-cn',
        sourceUrl: 'https://example.test/laboratory-cn',
        upstreamVersion: '2026-09-01',
      }],
    })}\n`)
    await runReferenceDatabaseCli(['migrate', '--database', referencePath])
    await runReferenceDatabaseCli(['import', '--database', referencePath, '--manifest', manifestPath])

    const password = `Test-${randomUUID()}-Aa1!`
    const runtime = await createClinMeshRuntime({
      activeReferenceReleaseId: 'lab-tubes-release-v1',
      authBaseUrl: 'http://localhost',
      authSecret: 'test-auth-secret-with-at-least-32-characters',
      cursorSecret: 'test-cursor-secret-with-at-least-32-characters',
      databasePath: join(directory, 'hospital.sqlite'),
      demoPassword: password,
      migrationMode: 'apply',
      referenceDatabasePath: referencePath,
      trustedOrigins: ['http://localhost'],
    })
    cleanups.push(async () => {
      await runtime.close()
      await rm(directory, { force: true, recursive: true })
    })

    async function login(name: string) {
      const res = await runtime.app.request('/api/auth/sign-in/email', {
        body: JSON.stringify({ email: `${name}@demo.clinmesh.local`, password }),
        headers: { 'content-type': 'application/json', origin: 'http://localhost' },
        method: 'POST',
      })
      expect(res.status).toBe(200)
      return res.headers.get('set-cookie')!.split(';', 1)[0]!
    }

    const admin = await login('admin')
    const doctor = await login('inpatient-doctor')
    const registrar = await login('registrar')
    const nurse = await login('ward-nurse')
    const adminContext = sessionContextSchema.parse(
      await (await runtime.app.request('/api/auth/context', { headers: { cookie: admin } })).json(),
    ).actor

    const prepareRes = await runtime.app.request('/api/his/v1/inpatient/pci-data/prepare', {
      body: JSON.stringify({ input: { expectedEpoch: adminContext.epoch } }),
      headers: {
        'content-type': 'application/json',
        cookie: admin,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(prepareRes.status).toBe(200)
    const pciPrepared = inpatientPciDataResponseSchema.parse(await prepareRes.json()).data
    expect(pciPrepared.package.laboratories.map(item => item.specimenContainer?.code)).toEqual([
      'edta-k2-purple',
      'edta-k2-purple',
      'edta-k2-purple',
      'sst-yellow',
      'citrate-blue',
      'sst-yellow',
      'sst-yellow',
      'sst-yellow',
      'sst-yellow',
    ])

    const catalogRes = await runtime.app.request('/api/his/v1/inpatient/investigation-catalog', {
      headers: { cookie: doctor },
    })
    expect(catalogRes.status).toBe(200)
    const catalog = inpatientInvestigationCatalogSchema.parse(await catalogRes.json())
    const byDisplay = (display: string) => catalog.items.find(item => item.display === display && item.kind === 'laboratory')

    expect(byDisplay('肝功能')).toMatchObject({
      available: true,
      isPanel: true,
      laboratoryCategory: 'biochemistry',
      memberCount: 1,
      specimen: '血清、血浆',
      specimenContainer: { code: 'sst-yellow', mergeable: true },
    })
    expect(byDisplay('尿常规')).toMatchObject({
      available: true,
      isPanel: true,
      laboratoryCategory: 'urinalysis-infection',
      specimenContainer: { code: 'sterile-urine', mergeable: true },
    })
    expect(byDisplay('炎症指标')).toMatchObject({
      available: true,
      isPanel: true,
      laboratoryCategory: 'urinalysis-infection',
      memberCount: 3,
      specimen: '混合标本',
      specimenContainer: { code: 'mixed-specimen', mergeable: false },
    })
    expect(byDisplay('红细胞沉降率测定')).toMatchObject({
      available: true,
      isPanel: false,
      laboratoryCategory: 'hematology-coagulation',
      specimenContainer: { code: 'esr-black', mergeable: true },
    })
    expect(byDisplay('甲状腺功能')).toMatchObject({
      available: true,
      isPanel: true,
      laboratoryCategory: 'endocrine-tumor',
      specimenContainer: { code: 'sst-yellow', mergeable: true },
    })
    expect(byDisplay('基础肿瘤标志物组合')).toMatchObject({
      available: true,
      isPanel: true,
      laboratoryCategory: 'endocrine-tumor',
      specimenContainer: { code: 'sst-yellow', mergeable: true },
    })

    const preopItems = catalog.items.filter(item => item.laboratoryCategory === 'preop-routine')
    expect(preopItems).toHaveLength(9)
    expect(preopItems.every(item => item.available && item.isPanel === false)).toBe(true)

    // 经固定 PCI 合成病例办理入院并开立肝功能组合，验证申请快照携带 specimenContainer
    const pciCaseRes = await runtime.app.request(getHisOperation('admin.pci-case.prepare').http.path, {
      body: JSON.stringify({ input: { expectedEpoch: adminContext.epoch } }),
      headers: {
        'content-type': 'application/json',
        cookie: admin,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(pciCaseRes.status).toBe(200)
    const pciSource = pciCaseSourceResponseSchema.parse(await pciCaseRes.json()).data
    const startInpatientOp = getHisOperation('registration.synthetic-case.start-inpatient')
    const startInput = {
      activeBriefRevision: pciSource.case.activeBriefRevision!,
      caseId: pciSource.case.caseId,
      expectedCaseRevision: pciSource.case.revision,
      expectedEpoch: adminContext.epoch,
      wardId: 'ward-general',
    }
    const admissionRes = await runtime.app.request(
      startInpatientOp.http.path.replace(':caseId', pciSource.case.caseId),
      {
        body: JSON.stringify(startInpatientOp.http.encodeBody!(startInput)),
        headers: {
          'content-type': 'application/json',
          cookie: registrar,
          'idempotency-key': randomUUID(),
          origin: 'http://localhost',
        },
        method: 'POST',
      },
    )
    expect(admissionRes.status).toBe(200)
    const started = startSyntheticInpatientCaseResponseSchema.parse(await admissionRes.json()).data
    const path = `/api/his/v1/inpatient/admissions/${started.admissionId}`
    const received = inpatientCommandResponseSchema.parse(await (await runtime.app.request(`${path}/receive`, {
      body: JSON.stringify({ input: { bedId: 'bed-general-1', encounterVersion: '1' } }),
      headers: {
        'content-type': 'application/json',
        cookie: nurse,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })).json()).data.admission

    const liverPanel = byDisplay('肝功能')!
    const issueRes = await runtime.app.request(`${path}/investigations/issue`, {
      body: JSON.stringify({
        input: {
          catalogVersion: liverPanel.version,
          encounterVersion: received.versionId,
          selection: {
            catalogItemId: liverPanel.id,
            indicationCode: liverPanel.indicationCodes[0]!,
            kind: 'laboratory',
          },
        },
      }),
      headers: {
        'content-type': 'application/json',
        cookie: doctor,
        'idempotency-key': randomUUID(),
        origin: 'http://localhost',
      },
      method: 'POST',
    })
    expect(issueRes.status).toBe(200)
    const issued = inpatientInvestigationResponseSchema.parse(await issueRes.json()).data
    expect(issued.laboratoryRequests[0]?.laboratoryService?.specimenContainer).toMatchObject({
      capColor: 'yellow',
      code: 'sst-yellow',
      containerNameZh: '促凝黄头管',
      mergeable: true,
      specimenCategoryZh: '血清',
    })
  }, 60_000)
})
