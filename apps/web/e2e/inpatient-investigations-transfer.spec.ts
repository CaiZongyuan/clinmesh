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

test('住院检验丢回执恢复、护士送检和转科三方交接通过真实入口',async({page,browserApp,source})=>{
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
  await page.getByRole('button',{name:`查看${admission.patientName}`,exact:true}).click()
  await page.getByLabel('住院检查项目',{exact:true}).click()
  await page.getByRole('option',{name:/合成白细胞计数/}).click()
  let issuePosts=0
  await page.route(`**${path}/investigations/issue`,async route=>{issuePosts+=1;const response=await route.fetch();expect(response.status()).toBe(200);await route.abort('failed')})
  await page.getByRole('button',{name:'开立住院检查',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('无法连接科灵脉智服务')
  await page.reload()
  await page.getByRole('button',{name:'恢复原住院操作',exact:true}).click()
  await page.getByRole('button',{name:`查看${admission.patientName}`,exact:true}).click()
  await expect(page.getByRole('region',{name:'住院检查检验',exact:true})).toContainText('待送检')
  expect(issuePosts).toBe(1)
  await page.unroute(`**${path}/investigations/issue`)
  await login('ward-nurse')
  await page.getByRole('button',{name:`查看${admission.patientName}`,exact:true}).click()
  const sendResponse=page.waitForResponse(response=>response.url().endsWith(`${path}/investigations/send`))
  await page.getByRole('button',{name:'校对并送检',exact:true}).click()
  expect((await sendResponse).status()).toBe(200)
  await browserApp.runtime.dispatchPending()
  await page.getByRole('button',{name:'刷新诊疗记录',exact:true}).click()
  await expect(page.getByRole('region',{name:'住院检查检验',exact:true})).toContainText('11.2')
  await login('inpatient-doctor')
  await page.getByRole('button',{name:`查看${admission.patientName}`,exact:true}).click()
  await page.getByRole('button',{name:'确认报告已阅',exact:true}).click()
  await page.getByLabel('转入病区',{exact:true}).click()
  await page.getByRole('option',{name:'外科病区',exact:true}).click()
  await page.getByLabel('转科理由',{exact:true}).fill('合成病区转科评估')
  await page.getByRole('button',{name:'申请转科',exact:true}).click()
  await expect(page.getByRole('region',{name:'住院转科',exact:true})).toContainText('待原科交接')
  await login('ward-nurse')
  await page.getByRole('button',{name:`查看${admission.patientName}`,exact:true}).click()
  await page.getByRole('button',{name:'完成原科交接',exact:true}).click()
  await expect(page.getByRole('region',{name:'住院转科',exact:true})).toContainText('待目标科接收')
  expect((await page.request.post(`${browserApp.origin}/api/auth/role`,{headers:{origin:browserApp.origin},data:{practitionerRoleId:'practitioner-role-ward-nurse-surgery'}})).status()).toBe(200)
  await page.reload()
  const incoming=page.getByRole('region',{name:'待接收转科',exact:true})
  await expect(incoming).toContainText(admission.patientName)
  await incoming.getByLabel('转科接收床位',{exact:true}).click()
  await page.getByRole('option',{name:'1床',exact:true}).click()
  await incoming.getByRole('button',{name:'接收转科并分床',exact:true}).click()
  await expect(page.getByRole('button',{name:`查看${admission.patientName}`,exact:true})).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
})
