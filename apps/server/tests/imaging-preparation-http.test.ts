import { rm } from 'node:fs/promises'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import {
  administratorImagingPreparationSchema,
  imagingCoverageSchema,
} from '@clinmesh/contracts/imaging'
import { scenarioGenerationTargetListSchema } from '@clinmesh/contracts/scenario'
import { afterEach, describe, expect, it } from 'vitest'
import { ScenarioGenerationProviderError } from '../src/application/scenario-data/provider.ts'
import type { createClinMeshRuntime } from '../src/runtime.ts'
import { syntheticCatalogAsset, writeSyntheticImagingCatalog } from './fixtures/imaging-catalog.ts'
import {
  acuteBronchitis,
  caseBundle,
  chestRadiographProcedure,
  createImagingRuntime,
  generateCase,
  hypertension,
  lungCancer,
  lungTransplant,
  mutation,
  pneumonia,
  prepareImaging,
  signIn,
  snomed,
  startOutpatientVisit,
} from './fixtures/imaging-scenario.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

const massCt = 'synthetic-mass-ct'
const massRadiograph = 'synthetic-mass-radiograph'
const clearRadiograph = 'synthetic-clear-radiograph'

function matchingRules(overrides: {
  clearAssets?: Record<string, string>
  massAssets?: Record<string, string>
  uncovered?: Array<{ codes: string[]; id: string; label: string }>
} = {}) {
  return {
    codeSystem: snomed,
    profiles: [
      {
        ageRange: [40, 79],
        assets: overrides.massAssets ?? { 'chest-ct-plain': massCt, 'chest-radiograph': massRadiograph },
        conditionCodes: [lungCancer.code, '162573006'],
        conflictProcedureCodes: [lungTransplant.code],
        finding: 'positive',
        id: 'lung-mass-male',
        label: '肺部单发肿块（成年男性）',
        sex: 'male',
      },
      {
        ageRange: [18, 89],
        assets: overrides.clearAssets ?? { 'chest-radiograph': clearRadiograph },
        conflictProcedureCodes: [lungTransplant.code],
        finding: 'negative',
        id: 'no-nodule',
        indexConditionCodes: [acuteBronchitis.code],
        label: '未见肺结节（急性支气管炎就诊）',
      },
    ],
    ruleVersion: 1,
    schemaVersion: 1,
    sourceExamCodes: { 'chest-ct-plain': ['16335031000119103'], 'chest-radiograph': [chestRadiographProcedure.code] },
    uncoveredConditions: overrides.uncovered ?? [{ codes: [pneumonia.code], id: 'pneumonia', label: '肺炎' }],
  }
}

describe('Imaging case preparation HTTP contract', () => {
  const runtimes: Runtime[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

  async function createRuntime(
    bundles: unknown[],
    options: { catalog?: boolean; persona?: boolean; targetedGeneration?: boolean } = {},
  ) {
    const created = await createImagingRuntime(bundles, options)
    temporaryDirectories.push(created.directory)
    runtimes.push(created.runtime)
    return created
  }

  const prepare = prepareImaging

  async function preparationOf(runtime: Runtime, cookie: string, caseId: string) {
    const response = await runtime.app.request(
      `/api/sim/v1/admin/synthetic-cases/${encodeURIComponent(caseId)}/imaging-preparation`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return administratorImagingPreparationSchema.parse(await response.json())
  }

  it('matches cases to published assets by source codes, demographics and one profile per case', async () => {
    const { catalogDirectory, runtime } = await createRuntime([
      caseBundle({
        gender: 'male',
        index: [
          { ...lungCancer, resourceType: 'Condition' },
          { ...chestRadiographProcedure, resourceType: 'Procedure' },
        ],
        name: '肺癌男',
      }),
      caseBundle({ gender: 'female', index: [{ ...lungCancer, resourceType: 'Condition' }], name: '肺癌女' }),
      // 来源在导出时已记录本次疾病两周后缓解；就诊当时它仍是现症。
      caseBundle({
        gender: 'female',
        index: [{ ...acuteBronchitis, resolved: true, resourceType: 'Condition' }],
        name: '支气管炎成人',
      }),
      caseBundle({ gender: 'male', index: [{ ...pneumonia, resourceType: 'Condition' }], name: '肺炎' }),
      caseBundle({ gender: 'male', index: [{ ...hypertension, resourceType: 'Condition' }], name: '高血压' }),
      caseBundle({
        gender: 'male',
        history: [{ ...lungTransplant, resourceType: 'Procedure' }],
        index: [{ ...lungCancer, resourceType: 'Condition' }],
        name: '肺移植后肺癌',
      }),
      caseBundle({
        birthDate: '2016-03-01',
        gender: 'male',
        index: [{ ...acuteBronchitis, resourceType: 'Condition' }],
        name: '支气管炎儿童',
      }),
      caseBundle({
        gender: 'male',
        history: [
          { ...lungCancer, resourceType: 'Condition' },
          { ...pneumonia, resolved: true, resourceType: 'Condition' },
        ],
        index: [{ ...acuteBronchitis, resourceType: 'Condition' }],
        name: '肺癌随访支气管炎',
      }),
    ])
    await writeSyntheticImagingCatalog(catalogDirectory, {
      assets: [
        syntheticCatalogAsset({ assetId: massCt, examCode: 'chest-ct-plain' }),
        syntheticCatalogAsset({ assetId: massRadiograph, examCode: 'chest-radiograph' }),
        syntheticCatalogAsset({ assetId: clearRadiograph, examCode: 'chest-radiograph' }),
      ],
      matching: matchingRules(),
    })
    const cookie = await signIn(runtime)
    const [cancerMale, cancerFemale, bronchitis, pneumoniaCase, unknown, transplant, child, followUp] = [
      await generateCase(runtime, cookie),
      await generateCase(runtime, cookie),
      await generateCase(runtime, cookie),
      await generateCase(runtime, cookie),
      await generateCase(runtime, cookie),
      await generateCase(runtime, cookie),
      await generateCase(runtime, cookie),
      await generateCase(runtime, cookie),
    ]

    const batch = await prepare(runtime, cookie)

    expect(batch.remaining).toBe(0)
    expect(batch.prepared).toHaveLength(8)
    const exams = (caseId: string) => batch.prepared
      .find(item => item.caseId === caseId)!.preparation!.exams
      .map(({ evidence, ...exam }) => ({
        ...exam,
        facts: evidence.facts.map(fact => `${fact.scope}:${fact.code}`),
        sourceExams: evidence.sourceExams.map(exam => exam.code),
      }))
    expect(exams(cancerMale)).toEqual([
      {
        assetId: massCt,
        examCode: 'chest-ct-plain',
        facts: [`index:${lungCancer.code}`],
        matchingProfileId: 'lung-mass-male',
        reportRevision: 1,
        sourceExams: [],
        status: 'ready',
      },
      {
        assetId: massRadiograph,
        examCode: 'chest-radiograph',
        facts: [`index:${lungCancer.code}`],
        matchingProfileId: 'lung-mass-male',
        reportRevision: 1,
        // 本次病例真值里的胸片操作是适合开立胸片的正向证据。
        sourceExams: [chestRadiographProcedure.code],
        status: 'ready',
      },
    ])
    expect(exams(cancerFemale).map(exam => [exam.status, exam.reason])).toEqual([
      ['unsupported', 'NO_ASSET_FOR_DEMOGRAPHICS'],
      ['unsupported', 'NO_ASSET_FOR_DEMOGRAPHICS'],
    ])
    // 同一病例的两项检查来自同一个适配条目；条目没有 CT 素材时不从别的条目拼凑。
    expect(exams(bronchitis)).toEqual([
      {
        examCode: 'chest-ct-plain',
        facts: [`index:${acuteBronchitis.code}`],
        matchingProfileId: 'no-nodule',
        reason: 'PROFILE_LACKS_EXAM',
        sourceExams: [],
        status: 'unsupported',
      },
      {
        assetId: clearRadiograph,
        examCode: 'chest-radiograph',
        facts: [`index:${acuteBronchitis.code}`],
        matchingProfileId: 'no-nodule',
        reportRevision: 1,
        sourceExams: [],
        status: 'ready',
      },
    ])
    expect(exams(pneumoniaCase).map(exam => [exam.status, exam.reason, exam.facts])).toEqual([
      ['unsupported', 'UNCOVERED_CONDITION', [`index:${pneumonia.code}`]],
      ['unsupported', 'UNCOVERED_CONDITION', [`index:${pneumonia.code}`]],
    ])
    // 没有来源依据的病例不会被当作正常。
    expect(exams(unknown).map(exam => [exam.status, exam.reason, exam.facts])).toEqual([
      ['unsupported', 'NO_APPLICABLE_RULE', []],
      ['unsupported', 'NO_APPLICABLE_RULE', []],
    ])
    expect(exams(transplant).map(exam => [exam.status, exam.reason, exam.facts])).toEqual([
      ['conflict', 'FIXED_FACT_CONFLICT', [`index:${lungCancer.code}`, `history:${lungTransplant.code}`]],
      ['conflict', 'FIXED_FACT_CONFLICT', [`index:${lungCancer.code}`, `history:${lungTransplant.code}`]],
    ])
    expect(exams(child).map(exam => [exam.status, exam.reason])).toEqual([
      ['unsupported', 'NO_ASSET_FOR_DEMOGRAPHICS'],
      ['unsupported', 'NO_ASSET_FOR_DEMOGRAPHICS'],
    ])
    // 既往未缓解的肺癌仍然决定影像表现；已缓解的肺炎不再阻止配片。
    expect(exams(followUp).map(exam => [exam.status, exam.assetId, exam.facts])).toEqual([
      ['ready', massCt, [`history:${lungCancer.code}`]],
      ['ready', massRadiograph, [`history:${lungCancer.code}`]],
    ])

    expect((await preparationOf(runtime, cookie, cancerMale)).bindings.map(binding => [binding.examCode, binding.assetId]))
      .toEqual([['chest-ct-plain', massCt], ['chest-radiograph', massRadiograph]])
    expect((await preparationOf(runtime, cookie, transplant)).bindings).toEqual([])

    const coverage = imagingCoverageSchema.parse(await (await runtime.app.request(
      '/api/sim/v1/admin/imaging-coverage',
      { headers: { cookie } },
    )).json())
    expect(coverage.catalog).toMatchObject({ packId: 'clinmesh-imaging-test', ruleVersion: 1 })
    expect(coverage.uncovered).toEqual([{ codes: [pneumonia.code], id: 'pneumonia', label: '肺炎' }])
    expect(coverage.exams.find(exam => exam.examCode === 'chest-ct-plain')?.profiles).toEqual([
      {
        ageRange: [40, 79],
        asset: { assetId: massCt, blockers: [], installed: false, published: true },
        conditionCodes: [lungCancer.code, '162573006'],
        finding: 'positive',
        id: 'lung-mass-male',
        label: '肺部单发肿块（成年男性）',
        sex: 'male',
      },
      {
        ageRange: [18, 89],
        asset: null,
        conditionCodes: [acuteBronchitis.code],
        finding: 'negative',
        id: 'no-nodule',
        label: '未见肺结节（急性支气管炎就诊）',
      },
    ])
    expect(coverage.cases).toEqual({
      exams: [
        {
          conflict: 1,
          examCode: 'chest-ct-plain',
          ready: 2,
          unsupported: [
            { count: 1, reason: 'NO_APPLICABLE_RULE' },
            { count: 2, reason: 'NO_ASSET_FOR_DEMOGRAPHICS' },
            { count: 1, reason: 'PROFILE_LACKS_EXAM' },
            { count: 1, reason: 'UNCOVERED_CONDITION' },
          ],
        },
        {
          conflict: 1,
          examCode: 'chest-radiograph',
          ready: 3,
          unsupported: [
            { count: 1, reason: 'NO_APPLICABLE_RULE' },
            { count: 2, reason: 'NO_ASSET_FOR_DEMOGRAPHICS' },
            { count: 1, reason: 'UNCOVERED_CONDITION' },
          ],
        },
      ],
      prepared: 8,
      total: 8,
    })
  })

  it('keeps preparation, coverage and asset identities away from clinical roles', async () => {
    const { catalogDirectory, runtime } = await createRuntime([
      caseBundle({ gender: 'male', index: [{ ...lungCancer, resourceType: 'Condition' }], name: '肺癌男' }),
    ])
    await writeSyntheticImagingCatalog(catalogDirectory, {
      assets: [
        syntheticCatalogAsset({ assetId: massCt, examCode: 'chest-ct-plain' }),
        syntheticCatalogAsset({ assetId: massRadiograph, examCode: 'chest-radiograph' }),
        syntheticCatalogAsset({ assetId: clearRadiograph, examCode: 'chest-radiograph' }),
      ],
      matching: matchingRules(),
    })
    const administrator = await signIn(runtime)
    const caseId = await generateCase(runtime, administrator)
    await prepare(runtime, administrator, [caseId])
    const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')

    const forbidden = await Promise.all([
      runtime.app.request('/api/sim/v1/admin/imaging-preparations', mutation(doctor, { input: {} })),
      runtime.app.request('/api/sim/v1/admin/imaging-coverage', { headers: { cookie: doctor } }),
      runtime.app.request(
        `/api/sim/v1/admin/synthetic-cases/${encodeURIComponent(caseId)}/imaging-preparation`,
        { headers: { cookie: doctor } },
      ),
    ])
    expect(forbidden.map(response => response.status)).toEqual([403, 403, 403])
    for (const response of forbidden) {
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe('ROLE_NOT_ALLOWED')
    }

    // 通用的病例读取入口不携带影像准备信息；它只出现在管理员专用入口。
    const generalCase = await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}`,
      { headers: { cookie: administrator } },
    )
    expect(generalCase.status).toBe(200)
    expect(await generalCase.text()).not.toMatch(/synthetic-mass|lung-mass-male|imaging/i)

    const missing = await runtime.app.request(
      '/api/sim/v1/admin/synthetic-cases/synthetic-case-missing/imaging-preparation',
      { headers: { cookie: administrator } },
    )
    expect(missing.status).toBe(404)
  })

  it('appends immutable revisions, lets unstarted cases follow the catalog and freezes bindings once started', async () => {
    const { catalogDirectory, runtime } = await createRuntime([
      caseBundle({ gender: 'male', index: [{ ...lungCancer, resourceType: 'Condition' }], name: '已开始肺癌' }),
      caseBundle({ gender: 'male', index: [{ ...lungCancer, resourceType: 'Condition' }], name: '未开始肺癌' }),
    ], { persona: true })
    await writeSyntheticImagingCatalog(catalogDirectory, {
      assets: [
        syntheticCatalogAsset({ assetId: massCt, examCode: 'chest-ct-plain', published: false }),
        syntheticCatalogAsset({ assetId: massRadiograph, examCode: 'chest-radiograph' }),
        syntheticCatalogAsset({ assetId: clearRadiograph, examCode: 'chest-radiograph' }),
      ],
      matching: matchingRules(),
    })
    const cookie = await signIn(runtime)
    const started = await generateCase(runtime, cookie)
    const waiting = await generateCase(runtime, cookie)

    const first = await prepare(runtime, cookie)
    expect(first.prepared.map(item => item.preparation?.revision)).toEqual([1, 1])
    expect(first.prepared[0]?.preparation?.exams.map(exam => [exam.examCode, exam.status, exam.reason])).toEqual([
      ['chest-ct-plain', 'unsupported', 'ASSET_NOT_PUBLISHED'],
      ['chest-radiograph', 'ready', undefined],
    ])
    // 素材清单没有变化时重复准备不产生新修订，也没有待准备的病例。
    expect(await prepare(runtime, cookie)).toEqual({ prepared: [], remaining: 0 })
    expect((await prepare(runtime, cookie, [started])).prepared[0]?.preparation?.revision).toBe(1)

    // 开始其中一个病例。
    await startOutpatientVisit(runtime, cookie, started)

    // 清单追加：CT 素材通过复核，适配条目的胸片换成另一套素材。
    const replacementRadiograph = 'synthetic-mass-radiograph-b'
    await writeSyntheticImagingCatalog(catalogDirectory, {
      assets: [
        syntheticCatalogAsset({ assetId: massCt, examCode: 'chest-ct-plain' }),
        syntheticCatalogAsset({ assetId: massRadiograph, examCode: 'chest-radiograph' }),
        syntheticCatalogAsset({ assetId: replacementRadiograph, examCode: 'chest-radiograph' }),
        syntheticCatalogAsset({ assetId: clearRadiograph, examCode: 'chest-radiograph' }),
      ],
      matching: matchingRules({
        massAssets: { 'chest-ct-plain': massCt, 'chest-radiograph': replacementRadiograph },
      }),
    })
    const second = await prepare(runtime, cookie)
    expect(second.prepared.map(item => [item.caseId, item.preparation?.revision, item.started])).toEqual([
      [started, 2, true],
      [waiting, 2, false],
    ].toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))))

    // 已开始病例：已绑定的胸片不被替换，尚未绑定的 CT 首次追加。
    const frozen = await preparationOf(runtime, cookie, started)
    expect(frozen.bindings.map(binding => [binding.examCode, binding.assetId, binding.preparationRevision])).toEqual([
      ['chest-ct-plain', massCt, 2],
      ['chest-radiograph', massRadiograph, 1],
    ])
    expect(frozen.preparation?.exams.map(exam => [exam.examCode, exam.status, exam.assetId])).toEqual([
      ['chest-ct-plain', 'ready', massCt],
      ['chest-radiograph', 'ready', massRadiograph],
    ])
    // 未开始病例：跟随新的准备修订。
    expect((await preparationOf(runtime, cookie, waiting)).bindings
      .map(binding => [binding.examCode, binding.assetId, binding.preparationRevision])).toEqual([
      ['chest-ct-plain', massCt, 2],
      ['chest-radiograph', replacementRadiograph, 2],
    ])

    // 重置后在新 Epoch 重放同一病例，绑定保持不变。
    const reset = await runtime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      mutation(cookie, {}),
    )
    expect(reset.status).toBe(200)
    expect((await preparationOf(runtime, cookie, started)).bindings).toEqual(frozen.bindings)
    expect((await prepare(runtime, cookie, [started])).prepared[0]).toMatchObject({
      bindings: frozen.bindings,
      preparation: { revision: 2 },
      started: true,
    })
  })

  it('does not treat a negative case as normal when the source has a conflicting operation or prior positive disease', async () => {
    const { catalogDirectory, runtime } = await createRuntime([
      caseBundle({ gender: 'female', index: [{ ...acuteBronchitis, resourceType: 'Condition' }], name: '支气管炎' }),
      caseBundle({
        gender: 'female',
        history: [{ ...lungTransplant, resourceType: 'Procedure' }],
        index: [{ ...acuteBronchitis, resourceType: 'Condition' }],
        name: '肺移植后支气管炎',
      }),
      caseBundle({
        gender: 'male',
        history: [{ ...lungCancer, resolved: true, resourceType: 'Condition' }],
        index: [{ ...acuteBronchitis, resourceType: 'Condition' }],
        name: '肺癌缓解后支气管炎',
      }),
    ])
    await writeSyntheticImagingCatalog(catalogDirectory, {
      assets: [
        syntheticCatalogAsset({ assetId: massCt, examCode: 'chest-ct-plain' }),
        syntheticCatalogAsset({ assetId: massRadiograph, examCode: 'chest-radiograph' }),
        syntheticCatalogAsset({ assetId: clearRadiograph, examCode: 'chest-radiograph' }),
      ],
      matching: matchingRules(),
    })
    const cookie = await signIn(runtime)
    const [plain, transplant, remission] = [
      await generateCase(runtime, cookie),
      await generateCase(runtime, cookie),
      await generateCase(runtime, cookie),
    ]
    const batch = await prepare(runtime, cookie)
    const radiograph = (caseId: string) => {
      const exam = batch.prepared.find(item => item.caseId === caseId)!.preparation!.exams
        .find(item => item.examCode === 'chest-radiograph')!
      return [exam.status, exam.reason, exam.evidence.facts.map(fact => `${fact.scope}:${fact.code}`)]
    }

    expect(radiograph(plain)).toEqual(['ready', undefined, [`index:${acuteBronchitis.code}`]])
    // 肺移植史与未手术的阴性素材冲突；已缓解的肺癌史同样不能当作“未见病灶”。
    expect(radiograph(transplant)).toEqual([
      'conflict',
      'FIXED_FACT_CONFLICT',
      [`index:${acuteBronchitis.code}`, `history:${lungTransplant.code}`],
    ])
    expect(radiograph(remission)).toEqual([
      'conflict',
      'FIXED_FACT_CONFLICT',
      [`index:${acuteBronchitis.code}`, `history:${lungCancer.code}`],
    ])
    expect((await preparationOf(runtime, cookie, transplant)).bindings).toEqual([])
    expect((await preparationOf(runtime, cookie, remission)).bindings).toEqual([])
  })

  it('keeps a started case binding but appends no exam once the current rules reject the case', async () => {
    const { catalogDirectory, runtime } = await createRuntime([
      caseBundle({ gender: 'female', index: [{ ...acuteBronchitis, resourceType: 'Condition' }], name: '支气管炎' }),
    ], { persona: true })
    const assets = [
      syntheticCatalogAsset({ assetId: massCt, examCode: 'chest-ct-plain' }),
      syntheticCatalogAsset({ assetId: massRadiograph, examCode: 'chest-radiograph' }),
      syntheticCatalogAsset({ assetId: clearRadiograph, examCode: 'chest-radiograph' }),
    ]
    await writeSyntheticImagingCatalog(catalogDirectory, { assets, matching: matchingRules() })
    const cookie = await signIn(runtime)
    const caseId = await generateCase(runtime, cookie)
    await prepare(runtime, cookie)
    await startOutpatientVisit(runtime, cookie, caseId)

    // 新规则为阴性条目追加 CT，同时把病例来源中的高血压列为未覆盖疾病。
    await writeSyntheticImagingCatalog(catalogDirectory, {
      assets,
      matching: matchingRules({
        clearAssets: { 'chest-ct-plain': massCt, 'chest-radiograph': clearRadiograph },
        uncovered: [{ codes: [hypertension.code], id: 'hypertension', label: '高血压' }],
      }),
    })
    await prepare(runtime, cookie, [caseId])
    const prepared = await preparationOf(runtime, cookie, caseId)
    expect(prepared.bindings.map(binding => [binding.examCode, binding.assetId])).toEqual([
      ['chest-radiograph', clearRadiograph],
    ])
    expect(prepared.preparation?.exams.map(exam => [exam.examCode, exam.status, exam.reason])).toEqual([
      ['chest-ct-plain', 'unsupported', 'UNCOVERED_CONDITION'],
      ['chest-radiograph', 'ready', undefined],
    ])
  })

  /** 提交一个定向生成任务并由 Server 处理。 */
  async function generateTargeted(runtime: Runtime, cookie: string, input: {
    gender: 'any' | 'female' | 'male'
    profileId: string
  }) {
    const response = await runtime.app.request('/api/sim/v1/scenario-generation-jobs', mutation(cookie, {
      name: '定向影像患者',
      population: { age: { maximum: 79, minimum: 40 }, count: 1, gender: input.gender },
      providerId: 'synthea',
      seeds: { clinical: 7331, population: 4242 },
      target: { kind: 'imaging-profile', profileId: input.profileId },
      timeRange: { end: '2026-08-01', start: '2020-01-01' },
      timeZone: 'Asia/Shanghai',
    }))
    return { response, processed: response.status === 200 ? await runtime.scenarioData.processNextGenerationJob() : undefined }
  }

  async function writeCatalog(catalogDirectory: string) {
    await writeSyntheticImagingCatalog(catalogDirectory, {
      assets: [
        syntheticCatalogAsset({ assetId: massCt, examCode: 'chest-ct-plain' }),
        syntheticCatalogAsset({ assetId: massRadiograph, examCode: 'chest-radiograph' }),
        syntheticCatalogAsset({ assetId: clearRadiograph, examCode: 'chest-radiograph' }),
      ],
      matching: matchingRules(),
    })
  }

  it('generates a patient for a selected imaging profile and leaves its preparation ready', async () => {
    const { catalogDirectory, runtime, syntheaProvider } = await createRuntime([
      // Synthea 本次抽到的人口无法满足保留条件，或得到的患者不满足条目：都按现有的确定性换 seed 重试。
      new ScenarioGenerationProviderError('KEEP_NOT_SATISFIED', 'Synthea could not keep a matching patient'),
      caseBundle({ gender: 'male', index: [{ ...hypertension, resourceType: 'Condition' }], name: '高血压' }),
      caseBundle({ gender: 'male', index: [{ ...lungCancer, resourceType: 'Condition' }], name: '肺癌男' }),
    ], { targetedGeneration: true })
    await writeCatalog(catalogDirectory)
    const cookie = await signIn(runtime)

    const targets = await runtime.app.request('/api/sim/v1/admin/scenario-generation-targets', { headers: { cookie } })
    expect(targets.status).toBe(200)
    const targetList = scenarioGenerationTargetListSchema.parse(await targets.json())
    expect(targetList.items).toEqual([
      { ageRange: [40, 79], kind: 'imaging-profile', label: '肺部单发肿块（成年男性）', profileId: 'lung-mass-male', sex: 'male' },
      { ageRange: [18, 89], kind: 'imaging-profile', label: '未见肺结节（急性支气管炎就诊）', profileId: 'no-nodule' },
    ])
    // 选项只有条目名称与适用人群，不含素材标识或匹配编码。
    expect(JSON.stringify(targetList)).not.toMatch(/synthetic-mass|synthetic-clear|\d{9}/)
    const doctorTargets = await runtime.app.request('/api/sim/v1/admin/scenario-generation-targets', {
      headers: { cookie: await signIn(runtime, 'doctor@demo.clinmesh.local') },
    })
    expect(doctorTargets.status).toBe(403)

    const { processed } = await generateTargeted(runtime, cookie, { gender: 'male', profileId: 'lung-mass-male' })
    expect(processed).toMatchObject({ error: null, status: 'succeeded' })
    expect(syntheaProvider.keeps).toEqual(Array.from({ length: 3 }, () => (
      { activeAny: [lungCancer.code, '162573006'], activeNone: [lungTransplant.code] }
    )))
    // 任务完成时已经完成影像准备。
    const prepared = await preparationOf(runtime, cookie, processed!.caseIds[0]!)
    expect(prepared.preparation?.exams.map(exam => [exam.examCode, exam.status, exam.matchingProfileId])).toEqual([
      ['chest-ct-plain', 'ready', 'lung-mass-male'],
      ['chest-radiograph', 'ready', 'lung-mass-male'],
    ])
  })

  it('fails a targeted job without leaving patients when no attempt satisfies the profile', async () => {
    const { catalogDirectory, runtime, syntheaProvider } = await createRuntime(Array.from({ length: 10 }, () => (
      caseBundle({ gender: 'female', index: [{ ...pneumonia, resourceType: 'Condition' }], name: '肺炎' })
    )), { targetedGeneration: true })
    await writeCatalog(catalogDirectory)
    const cookie = await signIn(runtime)

    const { processed } = await generateTargeted(runtime, cookie, { gender: 'any', profileId: 'no-nodule' })
    expect(processed).toMatchObject({ caseIds: [], error: { code: 'IMAGING_TARGET_NOT_MET' }, status: 'failed' })
    expect(syntheaProvider.keeps).toHaveLength(10)
    // 阴性条目排除阳性条目的疾病、未覆盖疾病和冲突操作。
    expect(syntheaProvider.keeps[0]).toEqual({
      activeAny: [acuteBronchitis.code],
      activeNone: [lungCancer.code, '162573006', pneumonia.code, lungTransplant.code],
    })
    const coverage = imagingCoverageSchema.parse(await (await runtime.app.request(
      '/api/sim/v1/admin/imaging-coverage',
      { headers: { cookie } },
    )).json())
    expect(coverage.cases.total).toBe(0)

    // 不存在的条目在处理时以不可用结束。
    const unknown = await generateTargeted(runtime, cookie, { gender: 'any', profileId: 'no-such-profile' })
    expect(unknown.processed).toMatchObject({ error: { code: 'IMAGING_TARGET_UNAVAILABLE' }, status: 'failed' })
  })

  it('rejects a targeted job when the Synthea Provider does not support targeted generation', async () => {
    const { catalogDirectory, runtime } = await createRuntime([])
    await writeCatalog(catalogDirectory)
    const cookie = await signIn(runtime)
    const { response } = await generateTargeted(runtime, cookie, { gender: 'male', profileId: 'lung-mass-male' })
    expect(response.status).toBe(503)
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('PROVIDER_NOT_AVAILABLE')
  })

  it('reports an invalid catalog to the administrator without preparing cases', async () => {
    const { catalogDirectory, runtime } = await createRuntime([
      caseBundle({ gender: 'male', index: [{ ...lungCancer, resourceType: 'Condition' }], name: '肺癌男' }),
    ])
    // 适配规则引用了清单中不存在的素材。
    await writeSyntheticImagingCatalog(catalogDirectory, {
      assets: [syntheticCatalogAsset({ assetId: massCt, examCode: 'chest-ct-plain' })],
      matching: matchingRules(),
    })
    const cookie = await signIn(runtime)
    const caseId = await generateCase(runtime, cookie)

    const response = await runtime.app.request('/api/sim/v1/admin/imaging-preparations', mutation(cookie, { input: {} }))
    expect(response.status).toBe(409)
    expect(apiErrorSchema.parse(await response.json()).error).toMatchObject({
      code: 'IMAGING_CATALOG_INVALID',
      message: expect.stringContaining(massRadiograph),
    })
    expect((await preparationOf(runtime, cookie, caseId)).preparation).toBeNull()
  })

  it('reports an unavailable catalog instead of preparing cases without rules', async () => {
    const { runtime } = await createRuntime([
      caseBundle({ gender: 'male', index: [{ ...lungCancer, resourceType: 'Condition' }], name: '肺癌男' }),
    ], { catalog: false })
    const cookie = await signIn(runtime)
    const caseId = await generateCase(runtime, cookie)

    const response = await runtime.app.request('/api/sim/v1/admin/imaging-preparations', mutation(cookie, { input: {} }))
    expect(response.status).toBe(409)
    expect(apiErrorSchema.parse(await response.json()).error.code).toBe('IMAGING_CATALOG_UNAVAILABLE')
    expect(await preparationOf(runtime, cookie, caseId)).toEqual({
      bindings: [],
      caseId,
      preparation: null,
      started: false,
    })
    const coverage = imagingCoverageSchema.parse(await (await runtime.app.request(
      '/api/sim/v1/admin/imaging-coverage',
      { headers: { cookie } },
    )).json())
    expect(coverage).toEqual({ cases: { exams: [], prepared: 0, total: 1 }, catalog: null, exams: [], uncovered: [] })
  })
})
