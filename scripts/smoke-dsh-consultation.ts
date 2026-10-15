import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { serve } from '@hono/node-server'
import { createServer } from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium, expect, type Request } from '@playwright/test'
import { z } from 'zod'
import { doctorCaseDetailSchema, clinicalDocumentDraftContentSchema, clinicalDocumentDraftResponseSchema } from '../packages/contracts/src/his.ts'
import { doctorRecommendationStateSchema } from '../packages/contracts/src/doctor-recommendations.ts'
import { decodeModelRoute } from '../packages/contracts/src/model-bridge.ts'
import { createClinMeshRuntime } from '../apps/server/src/runtime.ts'
import { DshModelProvider } from '../apps/server/src/infrastructure/ai/dsh-model-provider.ts'
import { persona, signIn, startConsultationCase, StubSyntheaProvider } from '../apps/server/tests/fixtures/consultation.ts'
import { journeyReplies, runRecordingJourney } from '../apps/web/e2e/consultation-recording-journey.ts'
import { recommendationFixture } from '../apps/web/e2e/doctor-recommendations-fixture.ts'
import { runRecommendationJourney } from '../apps/web/e2e/doctor-recommendations-journey.ts'
import { createInvestigationReferenceDatabase } from '../apps/web/e2e/investigation-workspace.fixture.ts'
import { startManagedProcess } from './dsh-upstreams-process.ts'
import { verificationEnvironment } from './dsh-upstreams-verify.ts'
import { parseLock } from './dsh-upstreams.ts'

// Explicit native smoke: the default uses only a synthetic host LlmAdapter.
// --live validates real multi-turn summarization/verification with fixed synthetic
// patient replies using an isolated copy of a configured profile.
const root = resolve(import.meta.dirname, '..')
const lock = parseLock(JSON.parse(await readFile(join(root, 'dsh-upstreams.lock.json'), 'utf8')))
const hostVersion = lock.components.find(component => component.name === '@deepseek-ai/dsh')!.version!
const runtimeDirectory = resolve(process.env.CLINMESH_DSH_SMOKE_RUNTIME ?? join(root, `.data/dsh-runtime/versions/dsh-${hostVersion}`))
const agUiDirectory = resolve(process.env.CLINMESH_DSH_SMOKE_AG_UI ?? join(root, '.data/dsh-runtime/ag-ui'))
const live = process.argv.includes('--live')
const summaryOnly = process.argv.includes('--summary-only')
const recommendationsOnly = process.argv.includes('--recommendations-only')
if (summaryOnly && !live) throw new Error('--summary-only requires --live')
if (summaryOnly && recommendationsOnly) throw new Error('Choose one smoke journey')
const sourceHome = process.env.CLINMESH_DSH_SMOKE_HOME
if (live && !sourceHome) throw new Error('--live requires CLINMESH_DSH_SMOKE_HOME with a configured isolated host')
const liveModel = process.env.CLINMESH_DSH_SMOKE_LIVE_MODEL
if (live && !liveModel) throw new Error('--live requires CLINMESH_DSH_SMOKE_LIVE_MODEL with an explicit configured route')
const cli = join(runtimeDirectory, 'node_modules/@deepseek-ai/dsh/lib/bin.js')
const installedHost = z.object({ version: z.literal(hostVersion) }).parse(JSON.parse(await readFile(join(runtimeDirectory, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')))
const git = promisify(execFile)
const revision = async (directory: string) => (await git('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim()
const agUiCommit = await revision(agUiDirectory)
expect(agUiCommit).toBe(lock.components.find(component => component.name === 'dsh-ag-ui')!.commit)
expect(await revision(join(root, 'vendor/dsh-react-surface'))).toBe(lock.components.find(component => component.name === 'dsh-react-surface')!.commit)
const sourceHashes = Object.fromEntries(await Promise.all([
  'scripts/smoke-dsh-consultation.ts', 'apps/web/e2e/consultation-recording-journey.ts', 'apps/web/e2e/consultation-recording-journey.spec.ts',
  'package.json', 'pnpm-lock.yaml', 'tsconfig.browser.json',
  'apps/server/src/application/consultation-history-summary.ts', 'apps/server/src/application/consultation-recording-service.ts',
  'apps/server/src/application/agent-integration-service.ts', 'apps/server/src/application/workflow-service.ts',
  'apps/server/src/app.ts', 'apps/dsh-web/src/agent-proof-bridge.ts', 'apps/dsh-web/src/execution-proof.ts',
  'apps/dsh-web/src/client/doctor-task.ts', 'apps/web/src/app/surface-agent-publisher.ts',
  'apps/server/drizzle/0059_consultation-history-summary.sql', 'apps/server/drizzle/0061_consultation-recording-sources.sql',
  'packages/contracts/src/his.ts', 'packages/contracts/src/agent.ts',
  'apps/web/src/app/doctor/consultation-history-review.tsx',
  'apps/web/e2e/doctor-recommendations-journey.ts', 'apps/web/e2e/doctor-recommendations-fixture.ts',
  'apps/server/src/application/doctor-recommendations-service.ts', 'apps/server/src/application/doctor-guideline-evidence.ts',
  'packages/contracts/src/doctor-recommendations.ts', 'packages/contracts/src/model-bridge.ts',
].map(async path => [path, createHash('sha256').update(await readFile(join(root, path))).digest('hex')])))
const scratch = await mkdtemp(join(tmpdir(), 'clinmesh-dsh-consultation-'))
const home = join(scratch, 'home')
const profile = join(home, 'profiles/web')
const controlPath = join(scratch, 'control.json')
const callsPath = join(scratch, 'calls.jsonl')
const secret = randomBytes(32).toString('hex')
const password = `Synthetic-${randomUUID()}-Aa1!`
const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n'
const report: Record<string, unknown> = { hostVersion: installedHost.version, agUiCommit, sourceCommit: await revision(root), sourceHashes,
  components: lock.components.map(({ name, version, commit }) => ({ name, version, commit })), syntheticData: true, summaryOnly, recommendationsOnly }
const browser = await chromium.launch({ headless: true })
let managed: ReturnType<typeof startManagedProcess> | undefined
let hospital: Awaited<ReturnType<typeof createClinMeshRuntime>> | undefined
let listener: ReturnType<typeof serve> | undefined
let phase = 'startup'
let hostOutput = ''
const bridgeEvents: Array<{ path: string; status: number; code?: string }> = []

async function freePort() {
  const server = createServer()
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing native smoke port')
  await new Promise<void>(done => server.close(() => done()))
  return address.port
}

try {
  const hostPort = await freePort()
  const serverPort = await freePort()
  const hostOrigin = `http://127.0.0.1:${hostPort}`
  const serverOrigin = `http://127.0.0.1:${serverPort}`
  const provider = new DshModelProvider({ origin: hostOrigin, secret, timeoutMs: 120_000, maxResponseBytes: 1048576 })
  await mkdir(join(profile, 'node_modules/@clinmesh'), { recursive: true })
  const links = [
    [join(root, 'apps/dsh-web'), join(profile, 'node_modules/@clinmesh/dsh-web')],
    [join(root, 'vendor/dsh-react-surface/packages/runtime'), join(profile, 'node_modules/dsh-react-surface')],
    [agUiDirectory, join(profile, 'node_modules/dsh-ag-ui')],
  ]
  for (const [target, link] of links) await symlink(target!, link!, process.platform === 'win32' ? 'junction' : 'dir')
  const synthetic = join(profile, 'node_modules/synthetic-consultation')
  await mkdir(synthetic)
  await writeFile(join(synthetic, 'package.json'), json({ name: 'synthetic-consultation', version: '0.0.0', type: 'module', main: './index.js' }))
  await writeFile(controlPath, json({ stage: 'initial', fail: false, released: false }))
  const sdk = pathToFileURL(join(runtimeDirectory, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href
  // The adapter records only routing/Tool metadata, never prompts, credentials or patient pixels.
  await writeFile(join(synthetic, 'index.js'), `import { LlmAdapter, ToolCallId } from ${JSON.stringify(sdk)};
import { appendFileSync, readFileSync } from 'node:fs';
const controlPath=${JSON.stringify(controlPath)}, callsPath=${JSON.stringify(callsPath)};
const replies=${JSON.stringify(journeyReplies)};
const control=()=>JSON.parse(readFileSync(controlPath,'utf8'));
const record=value=>appendFileSync(callsPath,JSON.stringify(value)+'\\n');
export const inject=['llm'];
class Adapter extends LlmAdapter {
  listModels(provider) { return Promise.resolve([{provider,id:'journey',name:'Synthetic consultation journey'}]); }
  async *stream(options) {
    const state=control();
    if(options.sessionId) {
      record({kind:'native-request', session:options.sessionId, tools:options.tools?.map(t=>t.name)});
      const last=options.messages.at(-1);
      if(last?.role==='tool') {
        record({kind:'native-result',codes:JSON.stringify(last).match(/(?:CLINMESH|AGENT)_[A-Z_]+/g)??[]});
        yield {type:'finish',reason:{kind:'stop'}}; return;
      }
      if(!state.tool) {
        yield {type:'text-delta',index:0,text:'合成验收会话已就绪。'};
        yield {type:'finish',reason:{kind:'stop'}}; return;
      }
      const tool=options.tools?.find(t=>t.name===state.tool);
      if(!tool) throw new Error('Expected native consultation Tool is absent');
      const args={...state.arguments};
      for(const [key,value] of Object.entries(tool.parameters.properties??{})) if('const' in value) args[key]=value.const;
      const id=ToolCallId('synthetic-'+Date.now()), encoded=JSON.stringify(args);
      record({kind:'native-call',name:tool.name,session:options.sessionId});
      yield {type:'block-start',index:0,blockType:'tool-call'};
      yield {type:'tool-call-delta',index:0,id,name:tool.name,argumentsDelta:encoded};
      yield {type:'block-end',index:0,block:{type:'tool-call',id,name:tool.name,arguments:encoded}};
      yield {type:'finish',reason:{kind:'tool-calls'}}; return;
    }
    if(options.system.includes('你只判断本条医生输入是否明确委托')) {
      record({kind:'auxiliary',history:false,session:false,tools:!!options.tools});
      yield {type:'text-delta',index:0,text:JSON.stringify({intent:'discuss',evidence:''})};
      yield {type:'finish',reason:{kind:'stop'}}; return;
    }
    const payload=JSON.parse(options.messages[0].content[0].text);
    const history=Array.isArray(payload.turns)&&Array.isArray(payload.history);
    record({kind:'auxiliary',history,session:false,tools:!!options.tools});
    let result;
    if(Array.isArray(payload.guidelines)&&(Array.isArray(payload.caseEvidence)||Array.isArray(payload.historyEvidence))) {
      result=state.recommendationResult;
    } else if(Array.isArray(payload.additions)) {
      result={additions:payload.additions.map((_,index)=>({index,faithful:true,complete:true,relationValid:true}))};
    } else if(history) {
      if(state.fail) { yield {type:'finish',reason:{kind:'error',failure:{code:'TIMEOUT',message:'Synthetic controlled timeout'}}}; return; }
      if(state.stage==='late') {
        record({kind:'held-extraction'});
        while(!control().released) { options.signal?.throwIfAborted(); await new Promise(done=>setTimeout(done,20)); }
      }
      const turn=payload.turns.at(-1);
      if(state.stage==='doctor-supplement') {
        result={additions:[['physicalExamination','神志清楚，四肢活动正常'],['assessment','头晕待查'],
          ['disposition','先完善检查'],['followUp','三日后复诊']].map(([field,text])=>({field,
          facts:[{text,sources:[{sourceTurnId:turn.id,quote:turn.messageText}]}],relation:'addition'}))};
      } else if(turn.kind==='doctor') {
        result={additions:[]};
      } else {
        const quotes=state.stage==='initial'?['头晕一周了。','站起来时更明显。']:[turn.messageText];
        result={additions:quotes.map(quote=>({field:'historyOfPresentIllness',facts:[{text:'患者自述：'+quote,sources:[{sourceTurnId:turn.id,quote}]}],
          relation:state.stage==='correction'?'correction':'addition',...(state.stage==='correction'?{targetAdditionId:payload.history.find(item=>item.field==='historyOfPresentIllness'&&item.text.includes('头晕五天')).id}:{})}))};
      }
    } else if(options.system.includes('患者档案')) result=${JSON.stringify(persona)};
    else result={reply:replies[state.stage]};
    yield {type:'text-delta',index:0,text:JSON.stringify(result)};
    yield {type:'finish',reason:{kind:'stop'}};
    if(history) record({kind:'settled-extraction',stage:state.stage});
  }
}
export function apply(ctx) {
  ctx.llm.registerAdapter(['synthetic-consultation'],new Adapter());
}
`)
  await writeFile(join(profile, 'package.json'), json({ name: 'synthetic-consultation-profile', version: '0.0.0', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-react-surface', 'dsh-ag-ui', '@clinmesh/dsh-web'] } } }))
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  let existingPatch = ''
  if (live) {
    await cp(join(sourceHome!, '.credentials.yaml'), join(home, '.credentials.yaml'))
    existingPatch = await readFile(join(sourceHome!, 'profiles/web/cordis.patch.yml'), 'utf8')
  }
  await writeFile(join(profile, 'cordis.patch.yml'), existingPatch + `
- id: agent-default-model
  config:
    provider: synthetic-consultation
    model: journey
- id: clinmesh-dsh-web
  config:
    bridgeSecret: !!js process.env.CLINMESH_DSH_BRIDGE_SECRET
    upstreamOrigin: !!js process.env.CLINMESH_DSH_UPSTREAM_ORIGIN
    generationModel: default
- id: directory-picker
  disabled: true
- insert:
    - id: synthetic-consultation
      name: synthetic-consultation
    - id: directory-picker-browse
      name: '@deepseek-ai/dsh-host-directory-picker-browse'
    - id: ui-directory-picker-browse
      name: '@deepseek-ai/dsh-client-ui-directory-picker-browse'
`)
  const recommendationReferenceDatabase = recommendationsOnly ? await createInvestigationReferenceDatabase(scratch) : undefined
  const recommendationReference = recommendationReferenceDatabase === undefined ? {}
    : { activeReferenceReleaseId: 'investigation-e2e-v1', referenceDatabasePath: recommendationReferenceDatabase }
  hospital = await createClinMeshRuntime({
    ...recommendationReference,
    chatCompletionsProvider: {
      resolveModel: (route, signal) => provider.resolveModel(route === 'dsh:default'
        ? 'dsh:{"provider":"synthetic-consultation","model":"journey"}' : route, signal),
      completeJson: async input => {
        if (recommendationsOnly && ['doctor_recommendations', 'doctor_recommendation_history_selection',
          'doctor_recommendation_catalog_selection', 'doctor_recommendation_verification'].includes(input.schemaName)) {
          const control = JSON.parse(await readFile(controlPath, 'utf8')) as Record<string, unknown>
          await writeFile(controlPath, json({ ...control, recommendationResult: recommendationFixture(input) }))
        }
        return provider.completeJson(input)
      },
    },
    dshBridgeSecret: secret,
    dshModelBridge: { origin: hostOrigin, secret, timeoutMs: 120_000, maxResponseBytes: 1048576 },
    authBaseUrl: serverOrigin, trustedOrigins: [serverOrigin, hostOrigin], authSecret: secret, cursorSecret: secret,
    databasePath: join(scratch, 'hospital.sqlite'), migrationMode: 'apply', demoPassword: password,
    syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
  })
  listener = serve({ hostname: '127.0.0.1', port: serverPort, fetch: request => hospital!.app.fetch(request) })
  managed = startManagedProcess(process.execPath, [cli, '--profile', 'web', '--port', String(hostPort), '--no-open'], {
    cwd: scratch, env: { ...verificationEnvironment(scratch), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1',
      CLINMESH_DSH_BRIDGE_SECRET: secret, CLINMESH_DSH_UPSTREAM_ORIGIN: serverOrigin },
  })
  managed.child.stdout?.on('data', chunk => { hostOutput += chunk })
  managed.child.stderr?.on('data', chunk => { hostOutput += chunk })
  let entry = ''
  for (let attempt = 0; attempt < 180; attempt++) {
    if (managed.child.exitCode !== null) {
      throw new Error('Native host exited during startup')
    }
    const token = /[?&]token=([A-Za-z0-9_-]+)/.exec(hostOutput)?.[1]
    if (token) {
      try {
        const candidate = `${hostOrigin}/?token=${token}`
        const response = await fetch(candidate, { redirect: 'manual', signal: AbortSignal.timeout(1000) })
        if (response.ok || [302, 303].includes(response.status)) { entry = candidate; break }
      } catch { /* Bounded startup; the private token is never printed. */ }
    }
    await new Promise(done => setTimeout(done, 500))
  }
  if (!entry) throw new Error('Native host readiness failed')
  console.log('隔离原生 DSH 宿主已就绪')
  phase = 'journey'
  const started = await startConsultationCase(hospital, password, serverOrigin)
  console.log('合成问诊已生成并分诊')
  const cookie = await signIn(hospital, 'doctor@demo.clinmesh.local', password, serverOrigin)
  const read = async () => doctorCaseDetailSchema.parse(await (await hospital!.app.request(
    `/api/his/v1/doctor/cases/${started.outpatientCaseId}`, { headers: { cookie } },
  )).json())
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1600, height: 1000 } })
  let activeTools: string[] = []
  let activeLeaseRequest: Request | undefined
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/lease')) { activeTools = []; activeLeaseRequest = request }
  })
  page.on('response', async response => {
    const path = new URL(response.url()).pathname
    if (!path.includes('page-context') && !path.endsWith('/lease')) return
    const event: { path: string; status: number; code?: string } = { path, status: response.status() }
    if (!response.ok()) {
      const parsed = z.object({ error: z.object({ code: z.string() }).optional() }).safeParse(await response.json().catch(() => null))
      if (parsed.success && parsed.data.error) event.code = parsed.data.error.code
    }
    bridgeEvents.push(event)
    if (path.endsWith('/lease') && response.ok() && response.request() === activeLeaseRequest) {
      const lease = z.object({ tools: z.array(z.object({ name: z.string() })) }).parse(response.request().postDataJSON())
      activeTools = lease.tools.map(tool => tool.name)
    }
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.name))
  const startupErrors: string[] = []
  const startupResponses: Array<{ path: string; status: number }> = []
  page.on('response', response => {
    if (phase === 'journey') startupResponses.push({ path: new URL(response.url()).pathname, status: response.status() })
  })
  page.on('pageerror', error => {
    if (phase === 'journey') startupErrors.push(error.message.replaceAll(secret, 'REDACTED').replaceAll(password, 'REDACTED')
      .replace(/token=[A-Za-z0-9_-]+/g, 'token=REDACTED').slice(0, 400))
  })
  await page.goto(entry)
  const launcher = page.getByRole('button', { name: '医院工作台', exact: true })
  const ready = async () => { await expect.poll(async () => {
    const actions = page.getByRole('button', { name: /^(我知道了|Got it|跳过|Skip|开始设置|Get started|继续|Continue|进入应用|Open app|稍后配置|Configure later)$/ })
    for (let index = (await actions.count()) - 1; index >= 0; index--) {
      const action = actions.nth(index)
      if (await action.isVisible() && await action.isEnabled()) {
        await action.click({ timeout: 1000 }).catch(() => {})
        return false
      }
    }
    const entryControl = phase === 'journey' ? page.getByRole('button', { name: '选择工作区', exact: true }) : launcher
    try { await entryControl.click({ trial: true, timeout: 500 }); return true }
    catch { return false }
  }, { timeout: 60_000 }).toBe(true) }
  try { await ready() } catch (error) {
    const text = (await page.locator('body').innerText()).replaceAll(secret, 'REDACTED').replaceAll(password, 'REDACTED')
      .replace(/token=[A-Za-z0-9_-]+/g, 'token=REDACTED').slice(0, 400)
    console.error('原生首页加载诊断', json({ errors: startupErrors, responses: startupResponses.slice(-12),
      buttons: await page.getByRole('button').allTextContents(), text }))
    throw error
  }
  phase = 'native-workspace'
  await page.getByRole('button', { name: '选择工作区', exact: true }).click()
  const addWorkspace = page.getByRole('menuitem', { name: '添加工作区…', exact: true })
  const editPath = page.getByRole('button', { name: '编辑路径', exact: true })
  // With no existing workspace the host may open the directory picker directly.
  await expect.poll(async () => await editPath.isVisible() || await addWorkspace.isVisible(), { timeout: 30_000 }).toBe(true)
  if (await addWorkspace.isVisible()) await addWorkspace.click()
  await page.getByRole('button', { name: '编辑路径', exact: true }).click()
  await page.getByRole('textbox', { name: '编辑路径', exact: true }).fill(scratch)
  await page.getByRole('textbox', { name: '编辑路径', exact: true }).press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()
  await ready()
  phase = 'native-session'
  const initialComposer = page.locator('[contenteditable="true"]').last()
  // Selecting a workspace can remount the composer while its session hydrates.
  // Populate only the current draft and observe the enabled send control.
  await expect.poll(async () => {
    await initialComposer.fill('合成验收：建立问诊会话。')
    return await initialComposer.innerText() === '合成验收：建立问诊会话。'
      && await page.getByRole('button', { name: '发送消息', exact: true }).isEnabled()
  }, { timeout: 30_000 }).toBe(true)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('合成验收会话已就绪。', { exact: true }).last()).toBeVisible({ timeout: 30_000 })
  phase = 'surface-login'
  await launcher.click()
  await page.getByRole('menuitem', { name: '打开 ClinMesh', exact: true }).click()
  await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
  await page.getByLabel('账户密码').fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('tab', { name: '待诊', exact: true }).click()
  await page.getByText('张琴', { exact: true }).first().click()
  await page.getByRole('button', { name: '开始首诊', exact: true }).click()
  await page.getByRole('tab', { name: '病历记录', exact: true }).click()
  await expect.poll(() => activeTools.includes('clinmesh_fill_clinical_document_draft'), { timeout: 60_000 }).toBe(true)
  if (recommendationsOnly) {
    phase = 'recommendations-journey'
    report.recommendations = await runRecommendationJourney({ page, read })
  }
  if (!summaryOnly && !recommendationsOnly) {
  phase = 'recording-journey'
  let control: Record<string, unknown> = { stage: 'initial', fail: false, released: false }
  const updateControl = async (patch: Record<string, unknown>) => { control = { ...control, ...patch }; await writeFile(controlPath, json(control)) }
  const calls = async () => (await readFile(callsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line =>
    z.object({ kind: z.string(), name: z.string().optional(), history: z.boolean().optional(), tools: z.union([z.boolean(), z.array(z.string())]).optional() }).passthrough().parse(JSON.parse(line)))
  const nativeCall = async (tool: string, args: object) => {
    await expect.poll(() => activeTools.includes(tool), { timeout: 60_000 }).toBe(true)
    await updateControl({ tool, arguments: args })
    // The native composer uses a contenteditable textbox outside the Surface ShadowRoot.
    const composer = page.locator('[contenteditable="true"]').last()
    await expect(composer).toBeVisible({ timeout: 30_000 })
    await composer.fill('合成验收：请执行当前病历操作。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
  }
  phase = 'doctor-supplement-without-tool'
  const doctorContent = '查体：神志清楚，四肢活动正常。评估：头晕待查。处置：先完善检查。随访：三日后复诊。'
  const callsBeforeDoctor = (await calls()).filter(call => call.kind === 'native-call').length
  await updateControl({ stage: 'doctor-supplement', tool: null })
  await page.locator('[contenteditable="true"]').last().fill(doctorContent)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(async () => (await read()).consultationRecording?.sources?.filter(source => source.kind === 'doctor').length,
    { timeout: 30_000 }).toBe(1)
  await expect.poll(async () => {
    const draft = (await read()).clinicalDocument?.draft
    return draft === undefined ? undefined : { physicalExamination: draft.physicalExamination,
      assessment: draft.assessment, disposition: draft.disposition, followUp: draft.followUp }
  }, { timeout: 30_000 }).toEqual({ physicalExamination: '神志清楚，四肢活动正常', assessment: '头晕待查',
    disposition: '先完善检查', followUp: '三日后复诊' })
  const doctorSource = (await read()).consultationRecording!.sources!.find(source => source.kind === 'doctor')!
  expect(doctorSource.messageText).toBe(doctorContent)
  expect(doctorSource.messageId).toBeTruthy()
  expect(doctorSource.rpcId).toBeTruthy()
  expect((await calls()).filter(call => call.kind === 'native-call').length).toBe(callsBeforeDoctor)
  await page.locator('[data-clinical-document-field="physicalExamination"]').getByRole('button', { name: '查看来源', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText(doctorContent)
  await expect(page.getByRole('dialog')).toContainText('医生')
  await page.getByRole('dialog').press('Escape')
  report.doctorSupplement = { sourceCount: 1, automaticFields: 4, nativeToolCalls: 0 }
  await updateControl({ stage: 'initial' })
  phase = 'recording-journey'
  report.journey = await runRecordingJourney({ page, read,
    reload: async () => {
      activeTools = []
      activeLeaseRequest = undefined
      await page.reload()
      await ready()
      await launcher.click({ timeout: 30_000 })
      await page.getByRole('menuitem', { name: '打开 ClinMesh', exact: true }).click()
    },
    stage: (stage, fail = false) => updateControl({ stage, fail }),
    waitForExtraction: async () => { await expect.poll(async () => (await calls()).some(call => call.kind === 'held-extraction')).toBe(true) },
    releaseExtraction: () => updateControl({ released: true }),
    settleExtraction: async () => {
      await expect.poll(async () => (await calls()).some(call => call.kind === 'settled-extraction' && call.stage === 'late')).toBe(true)
      await expect.poll(() => hospital!.database.driver.prepare("SELECT count(*) AS count FROM outbox_event WHERE status = 'claimed'").get()).toEqual({ count: 0 })
    },
    agentDraft: async () => {
      // The journey deliberately leaves an unsaved assessment to verify local
      // edit protection. Save it before testing a separate Agent draft action.
      const assessment = await page.getByLabel('评估', { exact: true }).inputValue()
      await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
      await expect.poll(async () => (await read()).clinicalDocument!.draft!.assessment).toBe(assessment)
      const current = (await read()).clinicalDocument!.draft!
      const draft = clinicalDocumentDraftContentSchema.parse(Object.fromEntries([
        'assessment', 'auxiliaryExamination', 'chiefComplaint', 'disposition', 'followUp',
        'historyOfPresentIllness', 'physicalExamination', 'priorMedicalHistory',
      ].map(key => [key, current[key as keyof typeof current]])))
      await nativeCall('clinmesh_fill_clinical_document_draft', { ...draft, assessment: '原生 Agent 草稿评估，待进一步核对。',
        auxiliaryExamination: draft.auxiliaryExamination ?? '', priorMedicalHistory: draft.priorMedicalHistory ?? '' })
      await expect(page.getByLabel('评估', { exact: true })).toHaveValue('原生 Agent 草稿评估，待进一步核对。', { timeout: 30_000 })
      expect((await read()).clinicalDocument!.draft!.assessment).toBe('原生 Agent 草稿评估，待进一步核对。')
    },
    agentSign: () => nativeCall('clinmesh_prepare_sign_document', {}),
    progress: message => console.log(message),
  })
  phase = 'agent-links'
  const linked = hospital.database.driver.prepare(`
    SELECT t.operation_id, t.status, t.result_json, t.request_id, t.audit_id, t.trace_id, t.proposal_id,
      p.status AS proposal_status, r.decision, r.command_request_id
    FROM agent_tool_call t
    LEFT JOIN agent_proposal p USING (workspace_id, epoch, proposal_id)
    LEFT JOIN agent_review_decision r USING (workspace_id, epoch, proposal_id)
    WHERE t.operation_id IN ('outpatient.record.draft.set', 'outpatient.record.sign.propose')
  `).all()
  const linkSchema = z.object({ operation_id: z.string(), status: z.literal('completed'), result_json: z.string(),
    request_id: z.string().nullable(), audit_id: z.string().nullable(), trace_id: z.string().nullable(),
    proposal_id: z.string().nullable(), proposal_status: z.string().nullable(), decision: z.string().nullable(), command_request_id: z.string().nullable() })
  const validated = z.array(linkSchema).length(2).parse(linked)
  // Draft actions return a Command receipt; only approved proposals persist the verified link in agent_tool_call.
  const draft = validated.find(link => link.operation_id === 'outpatient.record.draft.set')!
  expect(draft.proposal_id).toBeNull()
  const draftResult = z.object({ result: clinicalDocumentDraftResponseSchema }).parse(JSON.parse(draft.result_json)).result
  const draftLink = z.object({ request_id: z.string(), audit_id: z.string(), trace_id: z.string() }).parse(
    hospital.database.driver.prepare('SELECT request_id, audit_id, trace_id FROM command_receipt WHERE request_id = ? AND audit_id = ?').get(draftResult.requestId, draftResult.auditId))
  const proposal = linkSchema.extend({ request_id: z.string(), audit_id: z.string(), trace_id: z.string() }).parse(
    validated.find(link => link.operation_id === 'outpatient.record.sign.propose'))
  expect(proposal).toMatchObject({ proposal_status: 'approved', decision: 'approved', command_request_id: proposal.request_id })
  for (const link of [draftLink, proposal]) {
    expect(hospital.database.driver.prepare('SELECT count(*) AS count FROM command_receipt WHERE request_id = ? AND audit_id = ? AND trace_id = ?').get(
      link.request_id, link.audit_id, link.trace_id)).toEqual({ count: 1 })
    expect(hospital.database.driver.prepare('SELECT count(*) AS count FROM action_trace WHERE request_id = ? AND trace_id = ?').get(link.request_id, link.trace_id)).toEqual({ count: 1 })
    expect(hospital.database.driver.prepare('SELECT count(*) AS count FROM audit_log WHERE audit_id = ?').get(link.audit_id)).toEqual({ count: 1 })
  }
  const recorded = await calls()
  expect(recorded.filter(call => call.kind === 'auxiliary').every(call => call.tools === false)).toBe(true)
  report.agentLinks = [
    { operation: draft.operation_id, ...draftLink, queryVerified: true },
    { operation: proposal.operation_id, request_id: proposal.request_id, audit_id: proposal.audit_id, trace_id: proposal.trace_id,
      proposal_id: proposal.proposal_id, proposal_status: proposal.proposal_status, decision: proposal.decision },
  ]
  report.auxiliaryCalls = recorded.filter(call => call.kind === 'auxiliary').length
  report.nativeCalls = recorded.filter(call => call.kind === 'native-call').map(call => call.name)
  report.pageErrors = errors.length
  expect(errors).toEqual([])
  }
  if (live) {
    phase = 'live-model'
    const model = liveModel!
    report.liveRoute = decodeModelRoute(model)
    // New synthetic case, real DSH network boundary; the fixture persona remains explicit setup.
    let liveMode = false
    const liveReplies = ['昨天晚上开始发烧，最高量到38.5度，还咳嗽，但是没有痰。',
      '咳嗽也是昨晚开始的，胸口不疼，也不觉得喘。']
    let liveReplyIndex = 0
    const original = hospital
    const liveRuntime = await createClinMeshRuntime({
      ...recommendationReference,
      dshBridgeSecret: secret,
      chatCompletionsProvider: { resolveModel: (route, signal) => provider.resolveModel(route === 'dsh:default' ? model : route, signal),
        completeJson: input => input.schemaName === 'patient_persona'
          ? Promise.resolve({ content: JSON.stringify(persona), model: input.model })
          : input.schemaName === 'patient_dialogue_reply'
            ? Promise.resolve({ content: JSON.stringify({ reply: liveReplies[liveReplyIndex] }), model: input.model })
          : provider.completeJson(input) },
      dshModelBridge: { origin: hostOrigin, secret, timeoutMs: 120_000, maxResponseBytes: 1048576 },
      authBaseUrl: serverOrigin, trustedOrigins: [serverOrigin, hostOrigin], authSecret: secret, cursorSecret: secret,
      databasePath: join(scratch, 'live-hospital.sqlite'), migrationMode: 'apply', demoPassword: password,
      syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
    })
    try {
      hospital = liveRuntime
      const liveCase = await startConsultationCase(liveRuntime, password, serverOrigin)
      const liveCookie = await signIn(liveRuntime, 'doctor@demo.clinmesh.local', password, serverOrigin)
      const readLive = async () => doctorCaseDetailSchema.parse(await (await liveRuntime.app.request(
        `/api/his/v1/doctor/cases/${liveCase.outpatientCaseId}`, { headers: { cookie: liveCookie } },
      )).json())
      await page.context().clearCookies()
      await page.goto(entry)
      await ready()
      await launcher.click()
      await page.getByRole('menuitem', { name: '打开 ClinMesh', exact: true }).click()
      await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
      await page.getByLabel('账户密码').fill(password)
      await page.getByRole('button', { name: '登录', exact: true }).click()
      await page.getByRole('tab', { name: '待诊', exact: true }).click()
      await page.getByText('张琴', { exact: true }).first().click()
      await page.getByRole('button', { name: '开始首诊', exact: true }).click()
      if (recommendationsOnly) {
        phase = 'live-recommendations'
        const before = await readLive()
        const states = []
        for (const [kind, tab, region] of [
          ['diagnosis', '诊断', '诊断建议'], ['prescription', '处方', '处方建议'], ['laboratory', '检验检查', '检验建议'],
        ] as const) {
          await page.getByRole('tab', { name: tab, exact: true }).click()
          await expect(page.getByRole('region', { name: region, exact: true })).toBeVisible()
          const current = async () => doctorRecommendationStateSchema.parse(await (await liveRuntime.app.request(
            `/api/his/v1/doctor/cases/${liveCase.outpatientCaseId}/recommendations/${kind}`, { headers: { cookie: liveCookie } },
          )).json())
          await expect.poll(async () => (await current()).status, { timeout: 370_000 }).toMatch(/^(ready|missing-evidence)$/)
          const state = await current()
          expect(state.stale).toBe(false)
          states.push({ kind, status: state.status, items: state.items.length,
            guidelines: state.guidelines.length, caseEvidence: state.caseEvidence.length, missingInformation: state.missingInformation.length })
        }
        const after = await readLive()
        expect(after.diagnosis).toEqual(before.diagnosis)
        expect(after.medicationConclusion).toEqual(before.medicationConclusion)
        expect(after.laboratoryRequests).toEqual(before.laboratoryRequests)
        report.liveRecommendations = { states, realAuxiliaryModel: true, generatedClinicalFacts: false }
        liveMode = true
      } else {
      await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
      const begun = performance.now()
      for (const [index, question] of ['何时发热，最高体温多少，咳嗽有没有痰？', '咳嗽何时开始，有没有胸痛或气促？'].entries()) {
        liveReplyIndex = index
        await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
        await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill(question)
        await page.getByRole('button', { name: '向患者提问', exact: true }).click()
        await expect.poll(async () => (await readLive()).consultation!.turns.length, { timeout: 180_000 }).toBe(3 + 2 * index)
        await expect.poll(async () => {
          const recording = (await readLive()).consultationRecording!
          if (recording.status === 'failed') throw new Error('Live history generation failed')
          return recording.status
        }, { timeout: 370_000 }).toBe('pending')
      }
      await page.getByRole('tab', { name: '病历记录', exact: true }).click()
      const detail = await readLive()
      const additions = detail.consultationRecording!.additions.filter(addition => addition.status === 'pending')
      expect(detail.clinicalDocument?.draft).toBeUndefined()
      report.liveEvidence = { draftUnchanged: true,
        replies: liveReplies, additions: additions.map(({ summary, facts }) => ({ summary, facts })) }
      phase = 'live-summary-quality'
      expect(additions.length).toBeGreaterThan(0)
      const history = additions.filter(addition => addition.field === 'historyOfPresentIllness').map(addition => addition.summary).join('\n')
      expect(history).not.toContain('患者自述：')
      expect(history).toMatch(/38\.5/)
      expect(history).toMatch(/(?:自述|自测|居家|家中).*38\.5/)
      expect(history).toMatch(/昨晚|昨天晚上/)
      expect(history).toMatch(/发热|发烧/)
      expect(history).toMatch(/干咳|无痰|咳嗽.*(?:无|没有)痰/)
      expect(history).toMatch(/胸痛|胸口/)
      expect(history).toMatch(/气促|喘|呼吸困难/)
      expect(history).toMatch(/(?:否认|无|没有|不).*(?:胸痛|胸口)/)
      expect(history).toMatch(/(?:否认|无|没有|不).*(?:气促|喘|呼吸困难)/)
      expect(history).not.toMatch(/肺炎|听诊|查体正常|考虑诊断/)
      phase = 'live-summary-sources'
      const summarizedTurns = new Set<string>()
      for (const addition of additions) {
        expect(addition.facts?.length).toBeGreaterThan(0)
        for (const fact of addition.facts!) for (const source of fact.sources) {
          expect(detail.consultation!.turns.find(turn => turn.id === source.sourceTurnId)?.messageText).toContain(source.quote)
          summarizedTurns.add(source.sourceTurnId)
        }
      }
      const replyTurnIds = detail.consultation!.turns.filter(turn => liveReplies.includes(turn.messageText)).map(turn => turn.id)
      expect(replyTurnIds).toHaveLength(2)
      expect(replyTurnIds.every(id => summarizedTurns.has(id))).toBe(true)
      const merged = additions.find(addition => addition.field === 'historyOfPresentIllness'
        && replyTurnIds.every(id => addition.facts!.some(fact => fact.sources.some(source => source.sourceTurnId === id))))
      expect(merged).toBeDefined()
      phase = 'live-summary-source-dialog'
      await page.locator('[data-consultation-addition="pending"]').filter({ hasText: merged!.summary! })
        .getByRole('button', { name: '查看来源', exact: true }).click()
      await expect(page.getByRole('dialog', { name: '患者原回答', exact: true }).locator('blockquote')).toHaveText(liveReplies)
      await page.keyboard.press('Escape')
      report.live = { elapsedMs: Math.round(performance.now() - begun), additions: additions.length, status: 'pending',
        sourceVerified: true, summary: history, replies: liveReplies, facts: additions.map(addition => addition.facts),
        draftUnchanged: true, multiTurnSourceDialog: true, realAuxiliaryModel: true, syntheticPatientReplies: true }
      liveMode = true
      }
    } finally {
      report.liveJobs = liveRuntime.database.driver.prepare('SELECT status, error_code FROM consultation_recording_job').all()
      hospital = original
      await liveRuntime.close()
    }
    expect(liveMode).toBe(true)
  }
  report.pageErrors = errors.length
  expect(errors).toEqual([])
  console.log(recommendationsOnly ? '原生 DSH 指南建议、草稿采纳与人工确认验收通过'
    : summaryOnly ? '原生 DSH 多轮病史总结与来源验收通过' : '原生 DSH 问诊组合验收及 Tool → 人工批准 → Command 关联通过')
  if (process.env.CLINMESH_DSH_SMOKE_REPORT) await writeFile(resolve(process.env.CLINMESH_DSH_SMOKE_REPORT), json(report))
} catch (error) {
  // Playwright errors can contain the host token or provider input. Keep the public failure bounded.
  console.error('原生验收失败', phase, error instanceof Error ? error.name : 'UnknownError')
  if (error instanceof Error && ['TimeoutError', 'Error'].includes(error.name) && phase !== 'live-model') {
    console.error(error.message.replaceAll(secret, 'REDACTED').replaceAll(password, 'REDACTED')
      .replace(/token=[A-Za-z0-9_-]+/g, 'token=REDACTED').slice(0, 1000))
  }
  console.error('原生桥接响应', json(bridgeEvents.slice(-15)))
  const capturedCalls = await readFile(callsPath, 'utf8').catch(() => '')
  console.error('原生调用状态', json(capturedCalls.trim().split('\n').filter(Boolean).slice(-8).map(line => {
    const value = z.object({ kind: z.string(), name: z.string().optional(), codes: z.array(z.string()).optional(),
      provider: z.string().optional(), model: z.string().optional(), reason: z.string().optional(), code: z.string().optional() }).parse(JSON.parse(line))
    return value
  })))
  if (hospital !== undefined) console.error('页面工具状态', json(hospital.database.driver.prepare(
    "SELECT operation_id, status, json_extract(result_json, '$.error.code') AS error_code FROM agent_tool_call",
  ).all()))
  if (hospital !== undefined) console.error('记录任务状态', json(hospital.database.driver.prepare(
    'SELECT status, error_code FROM consultation_recording_job',
  ).all()))
  if (process.env.CLINMESH_DSH_SMOKE_REPORT) await writeFile(resolve(process.env.CLINMESH_DSH_SMOKE_REPORT), json({ ...report, failurePhase: phase }))
  process.exitCode = 1
} finally {
  await browser.close()
  await managed?.stop()
  await hospital?.close()
  if (listener && 'closeAllConnections' in listener) listener.closeAllConnections()
  if (listener) await new Promise<void>(done => listener!.close(() => done()))
  await rm(scratch, { recursive: true, force: true })
}
