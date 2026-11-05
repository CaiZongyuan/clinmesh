import { selectInpatientStage } from './inpatient-ui.ts'
import { addSecondaryInpatientWard } from '../../server/tests/fixtures/inpatient-secondary-ward.ts'
import { sourceArtifactHash } from '../../server/src/application/scenario-data/provider.ts'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inpatientCommandResponseSchema } from '@clinmesh/contracts/inpatient'
import { fhirResourceSchema } from '@clinmesh/contracts/fhir'
import { sessionContextSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { test as base, expect } from './fixtures.ts'
import { createInvestigationReferenceDatabase } from './investigation-workspace.fixture.ts'
import { closeQueue, openQueue } from './queue-overlay.fixture.ts'
import { inpatientInvestigationCatalogSchema, inpatientInvestigationsSchema } from '@clinmesh/contracts/inpatient-investigations'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'

const test=base.extend<{source:Awaited<ReturnType<typeof startConsultationCase>>}>({
  browserApp:async({webRoot},use)=>{
    const directory=await mkdtemp(join(tmpdir(),'clinmesh-inpatient-investigations-e2e-'))
    try {
      const referenceDatabasePath=await createInvestigationReferenceDatabase(directory)
      const app=await startBrowserServer(webRoot,{referenceDatabasePath,activeReferenceReleaseId:'investigation-e2e-v1',patientPersonaModel:'synthetic-persona',syntheaProvider:new class extends StubSyntheaProvider {
          override async generate() {
            const corpus=await super.generate()
            return {...corpus,sources:corpus.sources.map(source=>{
              const raw=z.object({entry:z.array(z.object({resource:z.record(z.string(),z.unknown())}).passthrough())}).passthrough().parse(source.raw)
              raw.entry.find(entry=>entry.resource.id==='iwtest')!.resource.valueQuantity={value:11.2,code:'10*9/L',unit:'10*9/L',system:'http://unitsofmeasure.org'}
              raw.entry.find(entry=>entry.resource.id==='ihtest')!.resource.valueQuantity={value:135,code:'g/L',unit:'g/L',system:'http://unitsofmeasure.org'}
              return {...source,raw,hash:sourceArtifactHash(raw)}
            })}
          }
        }(),
        chatCompletionsProvider:{completeJson:async input=>({model:input.model,content:JSON.stringify(persona)})}})
      try {await use(app)} finally {await app.close()}
    } finally {await rm(directory,{recursive:true,force:true})}
  },
  source:async({browserApp},use)=>{await use(await startConsultationCase(browserApp.runtime,browserApp.password,browserApp.origin))},
})

test('住院头部仅摘要两项真实检验，仍提示后续异常并可进入完整结果', async ({ page, browserApp, source }) => {
  test.setTimeout(90_000)
  const login = async (role: string) => expect((await page.request.post(`${browserApp.origin}/api/auth/sign-in/email`, {
    headers: { origin: browserApp.origin }, data: { email: `${role}@demo.clinmesh.local`, password: browserApp.password },
  })).status()).toBe(200)
  const post = (path: string, input: unknown) => page.request.post(`${browserApp.origin}${path}`, {
    headers: { origin: browserApp.origin, 'idempotency-key': randomUUID() }, data: { input },
  })
  await login('registrar')
  const encounter = fhirResourceSchema.parse(await (await page.request.get(`${browserApp.origin}/fhir/R5/Encounter/${source.encounterId}`)).json())
  const patientReference = z.object({ reference: z.string() }).parse(encounter.subject).reference
  const patient = fhirResourceSchema.parse(await (await page.request.get(`${browserApp.origin}/fhir/R5/${patientReference}`)).json())
  const context = sessionContextSchema.parse(await (await page.request.get(`${browserApp.origin}/api/auth/context`)).json())
  const admission = inpatientCommandResponseSchema.parse(await (await post('/api/his/v1/inpatient/admissions', {
    expectedEpoch: context.actor.epoch, patientId: patient.id, patientVersion: patient.meta!.versionId, admissionRoute: 'direct', wardId: 'ward-general', depositFen: 100000,
  })).json()).data.admission
  const path = `/api/his/v1/inpatient/admissions/${admission.id}`
  await login('ward-nurse')
  expect((await post(`${path}/receive`, { encounterVersion: admission.versionId, bedId: 'bed-general-1' })).status()).toBe(200)
  await login('inpatient-doctor')
  const catalog = inpatientInvestigationCatalogSchema.parse(await (await page.request.get(`${browserApp.origin}/api/his/v1/inpatient/investigation-catalog`)).json())
  for (const display of ['合成血红蛋白', '合成血红蛋白', '合成血红蛋白', '合成白细胞计数']) {
    const selected = catalog.items.find(item => item.kind === 'laboratory' && item.display === display)!
    const clinical = inpatientFullClinicalSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/clinical`)).json())
    expect((await post(`${path}/investigations/issue`, { encounterVersion: clinical.encounterVersion, catalogVersion: selected.version,
      selection: { kind: 'laboratory', catalogItemId: selected.id, indicationCode: selected.indicationCodes[0] },
    })).status()).toBe(200)
    let state = inpatientInvestigationsSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/investigations`)).json())
    const issued = state.laboratoryRequests.find(item => item.status === 'issued')!
    await login('ward-nurse')
    expect((await post(`${path}/investigations/send`, { requestId: issued.id, expectedRequestVersion: issued.version,
      serviceRequestVersion: issued.serviceRequestVersion, taskVersion: issued.taskVersion,
    })).status()).toBe(200)
    await login('inpatient-doctor')
    await expect.poll(async () => {
      await browserApp.runtime.dispatchPending()
      state = inpatientInvestigationsSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/investigations`)).json())
      return state.laboratoryRequests.find(item => item.id === issued.id)?.status
    }).toBe('reported')
    const reported = state.laboratoryRequests.find(item => item.id === issued.id)!
    expect(reported.report).toBeDefined()
    expect((await post(`${path}/investigations/acknowledge`, { requestId: reported.id, expectedRequestVersion: reported.version,
      serviceRequestVersion: reported.serviceRequestVersion, taskVersion: reported.taskVersion,
      diagnosticReportId: reported.report!.diagnosticReportId, diagnosticReportVersion: reported.report!.diagnosticReportVersion,
    })).status()).toBe(200)
  }
  const state = inpatientInvestigationsSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/investigations`)).json())
  expect(state.laboratoryRequests.flatMap(request => request.report?.results ?? []).map(result => result.interpretation).sort()).toEqual(['high', 'normal', 'normal', 'normal'])
  await page.setViewportSize({ width: 1101, height: 900 })
  await page.goto(`${browserApp.origin}/inpatient`)
  await page.getByRole('button', { name: `查看${admission.patientName}`, exact: true }).click()
  const summary = page.getByRole('region', { name: '检查检验结果', exact: true })
  await expect(summary.locator('span[title]')).toHaveCount(2)
  await expect(summary).toContainText('1 项异常')
  await summary.getByRole('button', { name: /查看检验结果（4项）/ }).click()
  const reports = page.getByRole('tabpanel', { name: '检查检验', exact: true })
  await expect(reports.getByRole('article')).toHaveCount(4)
  await reports.locator('summary').filter({ hasText: /^查看完整报告$/ }).last().click()
  await expect(reports).toContainText('11.2')
  await expect(reports).toContainText('135')
  await page.route(`**${path}/investigations`, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'SYNTHETIC_READ_FAILURE', message: '合成检验读取失败' } }) }))
  await openQueue(page)
  await page.getByRole('button', { name: '刷新', exact: true }).click()
  await closeQueue(page)
  await expect(summary.getByRole('alert')).toContainText('检验结果读取失败')
  await expect(summary.locator('span[title]')).toHaveCount(0)
  await expect(summary.getByRole('button', { name: /查看检验结果/ })).toHaveCount(0)
})

test('住院检验丢回执恢复、护士送检和转科三方交接通过真实入口',async({page,browserApp,source},info)=>{
  await addSecondaryInpatientWard(browserApp.runtime)
  const login=async(name:string,first=false)=>{
    if(!first){await page.getByRole('button',{name:'用户菜单'}).click();await page.getByRole('menuitem',{name:'退出登录'}).click()}
    await page.getByLabel('账户邮箱').fill(`${name}@demo.clinmesh.local`)
    await page.getByLabel('账户密码').fill(browserApp.password)
    await page.getByRole('button',{name:'登录',exact:true}).click()
    await expect(page.getByRole('button',{name:'用户菜单'})).toBeVisible()
  }
  const post=(path:string,input:unknown)=>page.request.post(`${browserApp.origin}${path}`,{headers:{origin:browserApp.origin,'idempotency-key':randomUUID()},data:{input}})
  await page.setViewportSize({width:390,height:900})
  await page.goto(`${browserApp.origin}/registration`)
  await login('registrar',true)
  const sourceEncounter=fhirResourceSchema.parse(await(await page.request.get(`${browserApp.origin}/fhir/R5/Encounter/${source.encounterId}`)).json())
  const patientReference=z.object({reference:z.string()}).parse(sourceEncounter.subject).reference
  const patient=fhirResourceSchema.parse(await(await page.request.get(`${browserApp.origin}/fhir/R5/${patientReference}`)).json())
  const session=sessionContextSchema.parse(await(await page.request.get(`${browserApp.origin}/api/auth/context`)).json())
  const admission=inpatientCommandResponseSchema.parse(await(await post('/api/his/v1/inpatient/admissions',{expectedEpoch:session.actor.epoch,patientId:patient.id,patientVersion:patient.meta!.versionId,admissionRoute:'direct',wardId:'ward-general',depositFen:100000})).json()).data.admission
  const path=`/api/his/v1/inpatient/admissions/${admission.id}`
  await login('ward-nurse')
  expect((await post(`${path}/receive`,{encounterVersion:admission.versionId,bedId:'bed-general-1'})).status()).toBe(200)
  await login('inpatient-doctor')
  await openQueue(page)
  await page.getByRole('button',{name:new RegExp(admission.patientName)}).click()
  await selectInpatientStage(page, "检查检验")
  await page.getByRole('button', { name: '开立住院检查', exact: true }).click()
  const composer = page.getByRole('dialog', { name: '开立住院检查', exact: true })
  await composer.getByRole('button',{name:/^选择合成白细胞计数/}).click()
  let issuePosts=0
  await page.route(`**${path}/investigations/issue`,async route=>{issuePosts+=1;const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed')})
  await composer.getByRole('button',{name:'开立住院检查',exact:true}).click()
  await expect(composer.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await page.getByRole('button',{name:'恢复原住院操作',exact:true}).click()
  await openQueue(page)
  await page.getByRole('button',{name:new RegExp(admission.patientName)}).click()
  await selectInpatientStage(page, "检查检验")
  await expect(page.getByRole('region',{name:'住院检查检验',exact:true})).toContainText('待送检')
  expect(issuePosts).toBe(1)
  await page.unroute(`**${path}/investigations/issue`)
  await login('ward-nurse')
  await openQueue(page)
  await page.getByRole('button',{name:new RegExp(admission.patientName)}).click()
  await selectInpatientStage(page, "检查检验")
  await page.setViewportSize({ width: 1600, height: 900 })
  const investigationRow = page.locator('article').filter({ hasText: '合成白细胞计数' })
  const titleBox = await investigationRow.evaluate(element => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.includes('合成白细胞计数')) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const rect = range.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width }
    }
    throw new Error('未找到检查名称')
  })
  const sendBox = await investigationRow.getByRole('button', { name: '校对并送检', exact: true }).boundingBox()
  expect(sendBox!.x).toBeGreaterThan(titleBox!.x + titleBox!.width)
  expect(Math.abs(sendBox!.y - titleBox!.y)).toBeLessThan(12)
  await page.setViewportSize({ width: 390, height: 900 })
  const sendResponse=page.waitForResponse(response=>response.url().endsWith(`${path}/investigations/send`))
  await page.getByRole('button',{name:'校对并送检',exact:true}).click()
  expect((await sendResponse).status()).toBe(200)
  await browserApp.runtime.dispatchPending()
  await openQueue(page)
  await page.getByRole('button',{name:'刷新',exact:true}).click()
  await closeQueue(page)
  await selectInpatientStage(page, "检查检验")
  await expect(page.getByRole('region',{name:'住院检查检验',exact:true})).toContainText('11.2')
  await login('inpatient-doctor')
  await openQueue(page)
  await page.getByRole('button',{name:new RegExp(admission.patientName)}).click()
  await selectInpatientStage(page, "检查检验")
  const reported = inpatientInvestigationsSchema.parse(await (await page.request.get(`${browserApp.origin}${path}/investigations`)).json()).laboratoryRequests.find(item => item.report)!
  const reportRow = page.locator('article').filter({ hasText: '合成白细胞计数' })
  await expect(reportRow.locator('.clinmesh-inpatient-item-meta')).toContainText('11.2')
  await expect(reportRow.locator('.clinmesh-inpatient-item-meta')).toContainText(reported.report!.results[0]!.referenceRange.text.replace(/（.*?）/g, '').trim())
  const fullReport = reportRow.locator('summary').filter({ hasText: /^查看完整报告$/ })
  await expect(fullReport).toBeVisible()
  await expect(fullReport.locator('..')).not.toHaveAttribute('open')
  await fullReport.click()
  await expect(reportRow.getByRole('columnheader', { name: '参考范围', exact: true })).toBeVisible()
  await expect(reportRow.getByRole('cell', { name: '偏高 ↑', exact: true })).toBeVisible()
  await page.getByRole('button',{name:"已阅",exact:true}).click()
  await expect(reportRow).toContainText('报告已阅')
  await expect(page.getByRole('tabpanel', { name: '检查检验', exact: true }).locator('.clinmesh-inpatient-turn > p')).toHaveText('报告已全部已阅')
  await expect(page.getByRole('region', { name: '当前操作', exact: true })).toContainText('报告已全部已阅')
  await expect(page.getByRole('region', { name: '当前操作', exact: true })).not.toContainText('等医技科室出报告')
  if (process.env.CLINMESH_CAPTURE_INPATIENT_PAGES === '1') {
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.locator('.clinmesh-card-workspace').evaluate(element => { element.style.width = '1101px' })
    const capture = info.outputPath('investigation-真实检验已阅与全文-1101-light.png')
    await page.locator('.clinmesh-card-workspace').screenshot({ path: capture, animations: 'disabled' })
    await info.attach('真实合成报告摘要、已阅与全文', { path: capture, contentType: 'image/png' })
  }
  await selectInpatientStage(page, "转科交接")
  await page.getByLabel('转入病区',{exact:true}).click()
  await page.getByRole('option',{name:'外科病区',exact:true}).click()
  await page.getByLabel('转科理由',{exact:true}).fill('合成病区转科评估')
  await page.getByRole('button',{name:'申请转科',exact:true}).click()
  await expect(page.getByRole('region',{name:'住院转科',exact:true})).toContainText('待原科交接')
  await login('ward-nurse')
  await openQueue(page)
  await page.getByRole('button',{name:new RegExp(admission.patientName)}).click()
  await selectInpatientStage(page, "转科交接")
  await page.getByRole('button',{name:'完成原科交接',exact:true}).click()
  await expect(page.getByRole('region',{name:'住院转科',exact:true})).toContainText('待目标科接收')
  expect((await page.request.post(`${browserApp.origin}/api/auth/role`,{headers:{origin:browserApp.origin},data:{practitionerRoleId:'practitioner-role-ward-nurse-surgery'}})).status()).toBe(200)
  await page.reload()
  const incoming=page.getByRole('region',{name:'待接收转科',exact:true})
  await expect(incoming).toContainText(admission.patientName)
  await incoming.getByLabel('转科接收床位',{exact:true}).click()
  await page.getByRole('option',{name:'1床',exact:true}).click()
  await incoming.getByRole('button',{name:'接收转科并分床',exact:true}).click()
  await openQueue(page)
  await expect(page.getByRole('button',{name:new RegExp(admission.patientName)})).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
})
