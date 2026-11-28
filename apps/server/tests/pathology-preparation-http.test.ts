import { rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { apiErrorSchema } from '@clinmesh/contracts/his'
import {
  administratorPathologyAssetSchema,
  administratorPathologyPreparationSchema,
  pathologyCoverageSchema,
} from '@clinmesh/contracts/pathology'
import jpeg from 'jpeg-js'
import { afterEach, describe, expect, it } from 'vitest'
import { reviewPathologyAssets } from '../src/infrastructure/imaging-assets/pathology-asset-store.ts'
import type { createClinMeshRuntime } from '../src/runtime.ts'
import {
  createImagingRuntime,
  generateCase,
  mutation,
  signIn,
  startOutpatientVisit,
} from './fixtures/imaging-scenario.ts'
import { installSyntheticPathologySlides, type SyntheticSlide } from './fixtures/pathology-catalog.ts'
import {
  breastCaseBundle,
  breastLesionExcision,
  lumpectomy,
  preparePathology,
  receptorNegative,
  receptorPositive,
} from './fixtures/pathology-scenario.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

const luminal = 'synthetic-slide-luminal'
const tripleNegative = 'synthetic-slide-triple-negative'
const luminalProfile = 'breast-er-pos-pr-pos-her2-neg-ln-pos-t2'
const tripleNegativeProfile = 'breast-er-neg-pr-neg-her2-neg-ln-neg-t1'
const tripleNegativeSlide: SyntheticSlide = {
  assetId: tripleNegative,
  clinical: { er: 'Negative', histologicType: 'Infiltrating Lobular Carcinoma', n: 'N0', pr: 'Negative', t: 'T1c' },
}

describe('Pathology case preparation HTTP contract', () => {
  const runtimes: Runtime[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

  async function createRuntime(bundles: unknown[], options: { persona?: boolean; targetedGeneration?: boolean } = {}) {
    const created = await createImagingRuntime(bundles, options)
    temporaryDirectories.push(created.directory)
    runtimes.push(created.runtime)
    const install = (slides: SyntheticSlide[], matching?: unknown) => installSyntheticPathologySlides({
      assetDirectory: created.pathologyAssetDirectory,
      catalogDirectory: created.pathologyCatalogDirectory,
      ...(matching === undefined ? {} : { matching }),
      slides,
    })
    return { ...created, install }
  }

  async function preparationOf(runtime: Runtime, cookie: string, caseId: string) {
    const response = await runtime.app.request(
      `/api/sim/v1/admin/synthetic-cases/${encodeURIComponent(caseId)}/pathology-preparation`,
      { headers: { cookie } },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return administratorPathologyPreparationSchema.parse(await response.json())
  }

  async function coverageOf(runtime: Runtime, cookie: string) {
    const response = await runtime.app.request('/api/sim/v1/admin/pathology-coverage', { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    return pathologyCoverageSchema.parse(await response.json())
  }

  it('prepares slides only for breast cases whose receptor, node and T facts all agree', async () => {
    const { install, runtime } = await createRuntime([
      breastCaseBundle({ name: '相符' }),
      breastCaseBundle({ her2: receptorPositive, name: '受体矛盾' }),
      breastCaseBundle({ name: '缺少孕激素受体', pr: null }),
      // Synthea 的 cT0（未见原发灶）不在 T1–T4 中。
      breastCaseBundle({ name: '未见原发灶', t: '1228882005' }),
      breastCaseBundle({ name: '没有可送检手术', procedures: [{ code: '122548005', display: '乳腺活检' }] }),
      breastCaseBundle({ name: '手术在本次就诊', procedures: [{ ...lumpectomy, indexVisit: true }] }),
      breastCaseBundle({ gender: 'male', name: '男性' }),
      breastCaseBundle({ name: '没有乳腺癌', withoutBreastCancer: true }),
      breastCaseBundle({
        er: receptorNegative,
        n: '1229967007',
        name: '三阴性两次手术',
        pr: receptorNegative,
        procedures: [lumpectomy, breastLesionExcision],
        t: '1228889001',
      }),
    ])
    await install([
      { assetId: luminal, reportRevisions: 2 },
      tripleNegativeSlide,
      { assetId: 'synthetic-slide-unpublished', clinical: { fish: 'Positive' }, published: false },
      { assetId: 'synthetic-slide-node-unknown', clinical: { fish: 'Positive', n: 'NX' } },
    ])
    const cookie = await signIn(runtime)
    const caseIds: string[] = []
    for (let index = 0; index < 9; index += 1) caseIds.push(await generateCase(runtime, cookie))

    const batch = await preparePathology(runtime, cookie)
    expect(batch.remaining).toBe(0)
    const exam = (index: number) => batch.prepared.find(item => item.caseId === caseIds[index])!.preparation!.exams[0]!

    expect(exam(0)).toMatchObject({ examCode: 'breast-slide-consultation', matchingProfileId: luminalProfile, status: 'ready' })
    expect(exam(0).sourceProcedures).toEqual([{
      assetId: luminal,
      code: lumpectomy.code,
      display: lumpectomy.display,
      performedAt: '2022-04-01T08:00:00+08:00',
      reportRevision: 2,
      sourceReference: 'urn:uuid:procedure-0',
      // 组织学类型来自素材，与来源固定事实分开记录。
      supplements: [{ fact: 'histologic-type', value: '浸润性导管癌' }],
    }])
    expect(exam(0).evidence.conditions).toEqual([{ code: '254837009', display: '乳腺恶性肿瘤', sourceReference: 'urn:uuid:breast-cancer' }])
    expect(exam(0).evidence.facts.map(fact => [fact.fact, fact.value, fact.sourceReference])).toEqual([
      ['estrogen-receptor', 'positive', 'urn:uuid:er'],
      ['progesterone-receptor', 'positive', 'urn:uuid:pr'],
      ['her2', 'negative', 'urn:uuid:her2'],
      ['lymph-nodes', 'positive', 'urn:uuid:n'],
      ['tumor-category', 'T2', 'urn:uuid:t'],
    ])

    // HER2 阳性的病例：已发布且字段齐全的切片都与之矛盾，缺少淋巴结分期的切片无法确认相容。
    expect(exam(1)).toMatchObject({ reason: 'FACT_UNKNOWN', status: 'unsupported' })
    expect(exam(2)).toMatchObject({ reason: 'FACT_UNKNOWN', status: 'unsupported' })
    expect(exam(3)).toMatchObject({ reason: 'FACT_UNKNOWN', status: 'unsupported' })
    expect(exam(4)).toMatchObject({ reason: 'NO_SOURCE_PROCEDURE', sourceProcedures: [], status: 'unsupported' })
    expect(exam(5)).toMatchObject({ reason: 'NO_SOURCE_PROCEDURE', sourceProcedures: [], status: 'unsupported' })
    expect(exam(6)).toMatchObject({ reason: 'NO_APPLICABLE_RULE', status: 'unsupported' })
    expect(exam(7)).toMatchObject({ reason: 'NO_APPLICABLE_RULE', status: 'unsupported' })
    expect(exam(8)).toMatchObject({ matchingProfileId: tripleNegativeProfile, status: 'ready' })
    expect(exam(8).sourceProcedures.map(item => [item.code, item.assetId, item.supplements[0]?.value])).toEqual([
      [lumpectomy.code, tripleNegative, '浸润性小叶癌'],
      [breastLesionExcision.code, tripleNegative, '浸润性小叶癌'],
    ])
    for (const index of [1, 2, 3]) expect(exam(index).sourceProcedures[0]).not.toHaveProperty('assetId')

    // 绑定按来源手术记录。
    const twoProcedures = await preparationOf(runtime, cookie, caseIds[8]!)
    expect(twoProcedures.bindings.map(binding => [binding.sourceProcedureReference, binding.assetId, binding.reportRevision])).toEqual([
      ['urn:uuid:procedure-0', tripleNegative, 1],
      ['urn:uuid:procedure-1', tripleNegative, 1],
    ])
    expect((await preparationOf(runtime, cookie, caseIds[1]!)).bindings).toEqual([])

    const coverage = await coverageOf(runtime, cookie)
    expect(coverage.catalog).toMatchObject({ packId: 'clinmesh-pathology-test', ruleVersion: 1 })
    expect(coverage.profiles.map(profile => [profile.id, profile.label, profile.assets])).toEqual([
      [
        'breast-er-neg-pr-neg-her2-neg-ln-neg-t1',
        '乳腺切片会诊：ER 阴性 · PR 阴性 · HER2 阴性 · 淋巴结阴性 · T1',
        [{ assetId: tripleNegative, blockers: [], installed: true, published: true }],
      ],
      [
        'breast-er-pos-pr-pos-her2-neg-ln-pos-t2',
        '乳腺切片会诊：ER 阳性 · PR 阳性 · HER2 阴性 · 淋巴结阳性 · T2',
        [{ assetId: luminal, blockers: [], installed: true, published: true }],
      ],
      [
        'breast-er-pos-pr-pos-her2-pos-ln-pos-t2',
        '乳腺切片会诊：ER 阳性 · PR 阳性 · HER2 阳性 · 淋巴结阳性 · T2',
        [{ assetId: 'synthetic-slide-unpublished', blockers: ['REVIEW_MISSING'], installed: true, published: false }],
      ],
    ])
    expect(coverage.gaps).toEqual([{
      assetId: 'synthetic-slide-node-unknown',
      blockers: [],
      installed: true,
      missing: ['lymph-nodes'],
      published: true,
    }])
    expect(coverage.cases).toEqual({
      exams: [{
        conflict: 0,
        examCode: 'breast-slide-consultation',
        ready: 2,
        unsupported: [
          { count: 3, reason: 'FACT_UNKNOWN' },
          { count: 2, reason: 'NO_APPLICABLE_RULE' },
          { count: 2, reason: 'NO_SOURCE_PROCEDURE' },
        ],
      }],
      prepared: 9,
      total: 9,
    })
  })

  it('reports a conflict when every published slide contradicts the case', async () => {
    const { install, runtime } = await createRuntime([breastCaseBundle({ her2: receptorPositive, name: '受体矛盾' })])
    await install([{ assetId: luminal }, tripleNegativeSlide])
    const cookie = await signIn(runtime)
    const caseId = await generateCase(runtime, cookie)

    const [prepared] = (await preparePathology(runtime, cookie, [caseId])).prepared
    expect(prepared?.preparation?.exams[0]).toMatchObject({ reason: 'FIXED_FACT_CONFLICT', status: 'conflict' })
    expect(prepared?.bindings).toEqual([])
    expect((await coverageOf(runtime, cookie)).cases.exams[0]).toMatchObject({ conflict: 1, ready: 0, unsupported: [] })
  })

  it('keeps preparation, coverage and slide identities away from clinical roles', async () => {
    const { install, runtime } = await createRuntime([breastCaseBundle({ name: '相符' })])
    await install([{ assetId: luminal }])
    const administrator = await signIn(runtime)
    const caseId = await generateCase(runtime, administrator)
    await preparePathology(runtime, administrator, [caseId])
    const doctor = await signIn(runtime, 'doctor@demo.clinmesh.local')

    const forbidden = await Promise.all([
      runtime.app.request('/api/sim/v1/admin/pathology-preparations', mutation(doctor, { input: {} })),
      runtime.app.request('/api/sim/v1/admin/pathology-coverage', { headers: { cookie: doctor } }),
      runtime.app.request(
        `/api/sim/v1/admin/synthetic-cases/${encodeURIComponent(caseId)}/pathology-preparation`,
        { headers: { cookie: doctor } },
      ),
      runtime.app.request(`/api/sim/v1/admin/pathology-assets/${luminal}`, { headers: { cookie: doctor } }),
      runtime.app.request(
        `/api/sim/v1/admin/pathology-assets/${luminal}/series/0/levels/0/tiles/0/0`,
        { headers: { cookie: doctor } },
      ),
    ])
    expect(forbidden.map(response => response.status)).toEqual([403, 403, 403, 403, 403])
    for (const response of forbidden) {
      expect(apiErrorSchema.parse(await response.json()).error.code).toBe('ROLE_NOT_ALLOWED')
    }

    // 通用的病例读取入口不携带病理准备信息；它只出现在管理员专用入口。
    const generalCase = await runtime.app.request(
      `/api/sim/v1/synthetic-cases/${encodeURIComponent(caseId)}`,
      { headers: { cookie: administrator } },
    )
    expect(generalCase.status).toBe(200)
    expect(await generalCase.text()).not.toMatch(/synthetic-slide|breast-er|pathology/i)

    const missing = await runtime.app.request(
      '/api/sim/v1/admin/synthetic-cases/synthetic-case-missing/pathology-preparation',
      { headers: { cookie: administrator } },
    )
    expect(missing.status).toBe(404)
  })

  it('appends immutable revisions, lets unstarted cases follow the catalog and freezes bindings once started', async () => {
    const { install, runtime } = await createRuntime([
      breastCaseBundle({ name: '已开始' }),
      breastCaseBundle({ name: '未开始' }),
    ], { persona: true })
    await install([{ assetId: luminal }])
    const cookie = await signIn(runtime)
    const started = await generateCase(runtime, cookie)
    const waiting = await generateCase(runtime, cookie)

    const first = await preparePathology(runtime, cookie)
    expect(first.prepared.map(item => item.preparation?.revision)).toEqual([1, 1])
    // 清单没有变化时重复准备不产生新修订，也没有待准备的病例。
    expect(await preparePathology(runtime, cookie)).toEqual({ prepared: [], remaining: 0 })
    expect((await preparePathology(runtime, cookie, [started])).prepared[0]?.preparation?.revision).toBe(1)

    await startOutpatientVisit(runtime, cookie, started)

    // 清单变化：原切片的事实改为与病例矛盾，另有一张新切片与病例相符。
    const replacement = 'synthetic-slide-luminal-b'
    await install([{ assetId: luminal, clinical: { er: 'Negative' } }, { assetId: replacement }])
    const second = await preparePathology(runtime, cookie)
    expect(second.prepared.map(item => [item.caseId, item.preparation?.revision, item.started])).toEqual([
      [started, 2, true],
      [waiting, 2, false],
    ].toSorted((left, right) => String(left[0]).localeCompare(String(right[0]))))

    // 已开始病例：已绑定的切片不被替换。
    const frozen = await preparationOf(runtime, cookie, started)
    expect(frozen.bindings.map(binding => [binding.assetId, binding.preparationRevision])).toEqual([[luminal, 1]])
    expect(frozen.preparation?.exams[0]).toMatchObject({ matchingProfileId: luminalProfile, status: 'ready' })
    expect(frozen.preparation?.exams[0]?.sourceProcedures[0]).toMatchObject({ assetId: luminal, reportRevision: 1 })
    // 未开始病例：跟随新的准备修订。
    expect((await preparationOf(runtime, cookie, waiting)).bindings
      .map(binding => [binding.assetId, binding.preparationRevision])).toEqual([[replacement, 2]])

    // 重置后在新 Epoch 重放同一病例，绑定保持不变。
    const reset = await runtime.app.request('/api/sim/v1/scenario-runs/scenario-run-1/actions/reset', mutation(cookie, {}))
    expect(reset.status).toBe(200)
    expect((await preparationOf(runtime, cookie, started)).bindings).toEqual(frozen.bindings)
    expect((await preparePathology(runtime, cookie, [started])).prepared[0]).toMatchObject({
      bindings: frozen.bindings,
      preparation: { revision: 2 },
      started: true,
    })
  })

  it('lets the administrator review an installed slide through bounded tile reads', async () => {
    const { install, runtime } = await createRuntime([])
    await install([{ assetId: luminal }, { assetId: 'synthetic-slide-unpublished', published: false }])
    const cookie = await signIn(runtime)

    const response = await runtime.app.request(`/api/sim/v1/admin/pathology-assets/${luminal}`, { headers: { cookie } })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    const asset = administratorPathologyAssetSchema.parse(await response.json())
    expect(asset).toMatchObject({
      assetId: luminal,
      clinical: { histologicType: 'Infiltrating Ductal Carcinoma', pathologicN: 'N1', pathologicT: 'T2' },
      facts: {
        'estrogen-receptor': 'positive',
        'her2': 'negative',
        'lymph-nodes': 'positive',
        'progesterone-receptor': 'positive',
        'tumor-category': 'T2',
      },
      publication: { publishedRevisions: [1], reasons: [] },
      reports: [{ checkIssues: [], revision: 1 }],
      study: { available: true, examCode: 'breast-slide-consultation' },
    })
    const [series] = asset.study.series
    if (series?.kind !== 'tiled-pyramid') throw new Error('Expected a tiled-pyramid series')
    // 原生 20 倍切片：20 倍、摄取派生的 10 倍和来源的 5 倍；缩略图不在其中。
    expect(series.levels.map(level => [level.magnification, level.width, level.height, level.tileWidth])).toEqual([
      [20, 41, 25, 16],
      [10, 21, 13, 16],
      [5, 10, 6, 16],
    ])
    expect(series).toMatchObject({ colorManaged: false, modality: 'SM', slideLabel: '1', tileFormat: 'jpeg' })

    const tile = (path: string) => runtime.app.request(
      `/api/sim/v1/admin/pathology-assets/${luminal}/series/0/${path}`,
      { headers: { cookie } },
    )
    for (const [level, column, row] of [[0, 0, 0], [0, 2, 1], [1, 1, 0], [2, 0, 0]]) {
      const read = await tile(`levels/${level}/tiles/${column}/${row}`)
      expect(read.status).toBe(200)
      expect(read.headers.get('cache-control')).toBe('no-store')
      const decoded = jpeg.decode(new Uint8Array(await read.arrayBuffer()), { useTArray: true })
      expect([decoded.width, decoded.height]).toEqual([16, 16])
    }
    // 层级、行列越界和不存在的序列都按不存在处理。
    for (const path of ['levels/3/tiles/0/0', 'levels/0/tiles/3/0', 'levels/0/tiles/0/2', 'levels/0/tiles/-1/0']) {
      expect((await tile(path)).status, path).not.toBe(200)
    }
    expect((await runtime.app.request(
      `/api/sim/v1/admin/pathology-assets/${luminal}/series/1/levels/0/tiles/0/0`,
      { headers: { cookie } },
    )).status).toBe(404)
    expect((await runtime.app.request('/api/sim/v1/admin/pathology-assets/no-such-slide', { headers: { cookie } })).status)
      .toBe(404)

    // 未复核的切片同样可以预览，供维护者复核后签署。
    const unpublished = administratorPathologyAssetSchema.parse(await (await runtime.app.request(
      '/api/sim/v1/admin/pathology-assets/synthetic-slide-unpublished',
      { headers: { cookie } },
    )).json())
    expect(unpublished.publication).toEqual({ publishedRevisions: [], reasons: [{ code: 'REVIEW_MISSING', revision: 1 }] })
    expect(unpublished.study.available).toBe(true)
  })

  it('excludes uninstalled slides from preparation and generation targets while keeping them visible in coverage', async () => {
    const { install, pathologyAssetDirectory, runtime } = await createRuntime([
      breastCaseBundle({ name: '相符切片未安装' }),
    ], { targetedGeneration: true })
    await install([{ assetId: luminal }, tripleNegativeSlide])
    await rm(join(pathologyAssetDirectory, 'installed', luminal), { recursive: true })
    const cookie = await signIn(runtime)
    const caseId = await generateCase(runtime, cookie)

    const [prepared] = (await preparePathology(runtime, cookie, [caseId])).prepared
    expect(prepared?.preparation?.exams[0]).toMatchObject({ reason: 'ASSET_NOT_INSTALLED', status: 'unsupported' })
    expect(prepared?.bindings).toEqual([])

    const coverage = await coverageOf(runtime, cookie)
    expect(coverage.profiles.find(profile => profile.id === luminalProfile)?.assets)
      .toEqual([{ assetId: luminal, blockers: [], installed: false, published: true }])
    expect(coverage.profiles.find(profile => profile.id === tripleNegativeProfile)?.assets)
      .toEqual([{ assetId: tripleNegative, blockers: [], installed: true, published: true }])
  })

  it('re-prepares cases when slide installation changes and preserves started bindings and their supplements', async () => {
    const { install, pathologyAssetDirectory, runtime } = await createRuntime([
      breastCaseBundle({ name: '已开始' }),
      breastCaseBundle({ name: '未开始' }),
    ], { persona: true })
    await install([{ assetId: luminal }])
    const cookie = await signIn(runtime)
    const started = await generateCase(runtime, cookie)
    const waiting = await generateCase(runtime, cookie)
    const first = await preparePathology(runtime, cookie)
    const firstHash = first.prepared[0]!.preparation!.catalog.hash
    const frozen = (await preparationOf(runtime, cookie, started)).bindings
    await startOutpatientVisit(runtime, cookie, started)
    const installedPath = join(pathologyAssetDirectory, 'installed', luminal)
    const savedPath = join(pathologyAssetDirectory, 'saved-slide')
    await rename(installedPath, savedPath)

    const removed = await preparePathology(runtime, cookie)
    expect(removed.prepared).toHaveLength(2)
    expect(removed.prepared.every(item => item.preparation?.catalog.hash !== firstHash)).toBe(true)
    const frozenAfterRemoval = await preparationOf(runtime, cookie, started)
    expect(frozenAfterRemoval.bindings).toEqual(frozen)
    expect(frozenAfterRemoval.preparation?.exams[0]?.sourceProcedures[0]).toMatchObject({
      assetId: luminal,
      supplements: [{ fact: 'histologic-type', value: '浸润性导管癌' }],
    })
    const waitingAfterRemoval = await preparationOf(runtime, cookie, waiting)
    expect(waitingAfterRemoval.bindings).toEqual([])
    expect(waitingAfterRemoval.preparation).toMatchObject({
      exams: [{ reason: 'ASSET_NOT_INSTALLED', status: 'unsupported' }],
      revision: 2,
    })

    await rename(savedPath, installedPath)
    const restored = await preparePathology(runtime, cookie)
    expect(restored.prepared).toHaveLength(2)
    expect(restored.prepared.every(item => item.preparation?.catalog.hash === firstHash)).toBe(true)
    expect((await preparationOf(runtime, cookie, started)).bindings).toEqual(frozen)
    const waitingAfterRestore = await preparationOf(runtime, cookie, waiting)
    expect(waitingAfterRestore.preparation).toMatchObject({ exams: [{ status: 'ready' }], revision: 3 })
    expect(waitingAfterRestore.bindings).toMatchObject([{ assetId: luminal, preparationRevision: 3 }])
    expect(await preparePathology(runtime, cookie)).toEqual({ prepared: [], remaining: 0 })
  })

  it('reports an unavailable or invalid catalog without preparing cases and without affecting radiology', async () => {
    const { install, pathologyCatalogDirectory, runtime } = await createRuntime([breastCaseBundle({ name: '相符' })])
    const cookie = await signIn(runtime)
    const caseId = await generateCase(runtime, cookie)

    // 没有病理清单：准备被拒绝，覆盖清单为空，放射的入口照常可用。
    const unavailable = await runtime.app.request('/api/sim/v1/admin/pathology-preparations', mutation(cookie, { input: {} }))
    expect(unavailable.status).toBe(409)
    expect(apiErrorSchema.parse(await unavailable.json()).error.code).toBe('PATHOLOGY_CATALOG_UNAVAILABLE')
    expect(await coverageOf(runtime, cookie)).toEqual({ cases: { exams: [], prepared: 0, total: 1 }, catalog: null, gaps: [], profiles: [] })
    expect((await runtime.app.request('/api/sim/v1/admin/imaging-coverage', { headers: { cookie } })).status).toBe(200)

    // 有素材但没有适配规则：素材可以复核，病例不参与匹配。
    await install([{ assetId: luminal }], false)
    expect((await runtime.app.request('/api/sim/v1/admin/pathology-preparations', mutation(cookie, { input: {} }))).status)
      .toBe(409)
    expect((await runtime.app.request(`/api/sim/v1/admin/pathology-assets/${luminal}`, { headers: { cookie } })).status)
      .toBe(200)

    // 适配规则无效。
    await writeFile(join(pathologyCatalogDirectory, 'matching.json'), '{"schemaVersion":1}\n')
    const invalid = await runtime.app.request('/api/sim/v1/admin/pathology-preparations', mutation(cookie, { input: {} }))
    expect(invalid.status).toBe(409)
    expect(apiErrorSchema.parse(await invalid.json()).error.code).toBe('PATHOLOGY_CATALOG_INVALID')
    expect((await preparationOf(runtime, cookie, caseId)).preparation).toBeNull()
  })

  it('re-prepares a waiting case when a published report is edited and signed again under the same revision', async () => {
    const { install, pathologyAssetDirectory, pathologyCatalogDirectory, runtime } = await createRuntime([
      breastCaseBundle({ name: '未开始' }),
    ])
    await install([{ assetId: luminal }])
    const cookie = await signIn(runtime)
    await generateCase(runtime, cookie)
    expect((await preparePathology(runtime, cookie)).prepared[0]?.preparation?.revision).toBe(1)

    // 生成草稿的 prompt 改动后重新复核签署：发布的仍是修订 1，但签署的内容已经不同，未开始的病例须重新绑定。
    await writeFile(join(pathologyCatalogDirectory, 'prompts', 'breast-pathology-report-v1.md'), '# Revised synthetic prompt\n')
    await reviewPathologyAssets({
      assetDirectory: pathologyAssetDirectory,
      catalogDirectory: pathologyCatalogDirectory,
      conclusion: 'approved',
      reviewer: 'synthetic-reviewer',
      reviewerIsPathologist: true,
    })
    expect((await preparePathology(runtime, cookie)).prepared[0]?.preparation?.revision).toBe(2)
  })
})
