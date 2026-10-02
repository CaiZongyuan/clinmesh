import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  apiErrorSchema,
  doctorCaseDetailSchema,
  imagingRequestDraftResponseSchema,
  issueImagingRequestResponseSchema,
} from '@clinmesh/contracts/his'
import { imagingStudyViewSchema } from '@clinmesh/contracts/imaging'
import { afterEach, describe, expect, it } from 'vitest'
import { readActionTraceMetrics, SqlitePerformanceProbe } from '../src/performance/sqlite-performance-probe.ts'
import type { createClinMeshRuntime } from '../src/runtime.ts'
import { installSyntheticImagingAssets } from './fixtures/imaging-catalog.ts'
import {
  caseBundle,
  createImagingRuntime,
  generateCase,
  lungCancer,
  mutation,
  prepareImaging,
  signIn,
  snomed,
  startConsultation,
} from './fixtures/imaging-scenario.ts'

type Runtime = Awaited<ReturnType<typeof createClinMeshRuntime>>

const massCt = 'synthetic-mass-ct'
const massRadiograph = 'synthetic-mass-radiograph'

describe('Imaging study read boundary HTTP contract', () => {
  const runtimes: Runtime[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.close()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
  })

  /** 一个已发布胸部 CT 检查的接诊：返回本院检查标识与各角色会话。 */
  async function reportedCtStudy(performanceObserver?: SqlitePerformanceProbe) {
    const created = await createImagingRuntime([caseBundle({
      gender: 'male',
      index: [{ ...lungCancer, resourceType: 'Condition' }],
      name: '肺癌男',
    })], { ...(performanceObserver === undefined ? {} : { performanceObserver }), persona: true })
    temporaryDirectories.push(created.directory)
    runtimes.push(created.runtime)
    const { runtime } = created
    await installSyntheticImagingAssets({
      assetDirectory: created.assetDirectory,
      assets: [
        { assetId: massCt, examCode: 'chest-ct-plain' },
        { assetId: massRadiograph, examCode: 'chest-radiograph' },
      ],
      catalogDirectory: created.catalogDirectory,
      matching: {
        codeSystem: snomed,
        profiles: [{
          ageRange: [40, 79],
          assets: { 'chest-ct-plain': massCt, 'chest-radiograph': massRadiograph },
          conditionCodes: [lungCancer.code],
          finding: 'positive',
          id: 'lung-mass-male',
          label: '肺部单发肿块（成年男性）',
          sex: 'male',
        }],
        ruleVersion: 1,
        schemaVersion: 1,
        sourceExamCodes: {},
        uncoveredConditions: [],
      },
    })
    const administrator = await signIn(runtime)
    const syntheticCaseId = await generateCase(runtime, administrator)
    await prepareImaging(runtime, administrator, [syntheticCaseId])
    const visit = await startConsultation(runtime, administrator, syntheticCaseId)
    const expectedVersions = { [`Encounter/${visit.encounterId}`]: '3' }
    const draft = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/imaging-request/draft`,
      mutation(visit.doctor, {
        expectedVersions,
        input: { expectedDraftVersion: 0, indication: '咳嗽两周', serviceId: 'imaging-chest-ct-plain' },
      }, 'PUT'),
    )
    const { draftVersion } = imagingRequestDraftResponseSchema.parse(await draft.json()).data
    const issued = await runtime.app.request(
      `/api/his/v1/encounters/${visit.encounterId}/imaging-request/actions/issue`,
      mutation(visit.doctor, { expectedVersions, input: { expectedDraftVersion: draftVersion } }),
    )
    issueImagingRequestResponseSchema.parse(await issued.json())
    while (await runtime.dispatcher.dispatchOnce() !== undefined) { /* 执行到报告发布 */ }
    const detail = doctorCaseDetailSchema.parse(await (await runtime.app.request(
      `/api/his/v1/doctor/cases/${visit.outpatientCaseId}`,
      { headers: { cookie: visit.doctor } },
    )).json())
    const studyId = detail.imagingRequests!.requests[0]!.report!.studyId
    return { ...created, ...visit, administrator, studyId }
  }

  it('reads the first frame within a fixed statement budget and writes nothing per pixel block', async () => {
    const probe = new SqlitePerformanceProbe()
    const { doctor, runtime, studyId } = await reportedCtStudy(probe)
    const studyPath = `/api/his/v1/imaging-studies/${studyId}`
    const persisted = () => ({
      audit: runtime.database.driver.prepare('SELECT COUNT(*) AS rows FROM audit_log').get(),
      trace: readActionTraceMetrics(runtime.database),
    })
    const before = persisted()

    probe.reset()
    const described = await runtime.app.request(studyPath, { headers: { cookie: doctor } })
    const study = imagingStudyViewSchema.parse(await described.json())
    const description = probe.snapshot()
    // 会话与岗位解析、检查读取授权各占固定的只读语句；预算随实现收紧，不随层数增长。
    expect(description.statementCount).toBeLessThanOrEqual(4)
    expect(description.writeCount).toBe(0)

    // 一例 CT 有数百层，每层至少一次像素块请求：每个请求的数据库开销必须固定且只读。
    const ctSeries = study.series[0]
    if (ctSeries?.kind !== 'frame-stack') throw new Error('Expected a frame-stack series')
    for (const [frameIndex, frame] of ctSeries.frames.entries()) {
      for (const blockIndex of frame.blocks.keys()) {
        probe.reset()
        const block = await runtime.app.request(
          `${studyPath}/series/0/frames/${frameIndex}/blocks/${blockIndex}`,
          { headers: { cookie: doctor } },
        )
        expect(block.status).toBe(200)
        expect((await block.arrayBuffer()).byteLength).toBeLessThanOrEqual(2 * 1024 * 1024)
        const read = probe.snapshot()
        expect(read.statementCount).toBeLessThanOrEqual(4)
        expect(read.writeCount).toBe(0)
        expect(read.rowsWritten).toBe(0)
      }
    }
    // 阅片不产生 Audit Event 或 Action Trace：读取像素不是业务命令。
    expect(persisted()).toEqual(before)
  })

  function int16Values(buffer: ArrayBuffer): number[] {
    return Array.from(new Int16Array(buffer))
  }

  it('serves the study description and bounded pixel blocks to the responsible doctor only', async () => {
    const { administrator, doctor, runtime, studyId } = await reportedCtStudy()
    const studyPath = `/api/his/v1/imaging-studies/${studyId}`

    const described = await runtime.app.request(studyPath, { headers: { cookie: doctor } })
    expect(described.status).toBe(200)
    expect(described.headers.get('cache-control')).toBe('private, no-store')
    const text = await described.text()
    // 读取描述只含本院检查标识与显示所需的几何，不含素材标识、文件位置或来源信息。
    expect(text).not.toMatch(/synthetic-mass|offset|frames\.bin|installed|2\.25\.4|SYNTHETIC-0001/)
    const study = imagingStudyViewSchema.parse(JSON.parse(text))
    expect(study).toMatchObject({ available: true, examCode: 'chest-ct-plain', studyId })
    expect(study.series).toHaveLength(1)
    const [series] = study.series
    if (series?.kind !== 'frame-stack') throw new Error('Expected a frame-stack series')
    expect(series).toMatchObject({ kind: 'frame-stack', modality: 'CT', pixelFormat: 'int16', valueUnit: 'hu' })
    expect(series?.frames.map(frame => frame.positionMm)).toEqual([0, -80, -160])
    expect(series?.frames[0]).toMatchObject({
      blocks: [{ length: 12, rowCount: 2, rowStart: 0 }],
      columns: 3,
      pixelSpacingMm: [0.7, 0.8],
      rows: 2,
    })

    const block = await runtime.app.request(`${studyPath}/series/0/frames/1/blocks/0`, { headers: { cookie: doctor } })
    expect(block.status).toBe(200)
    expect(block.headers.get('content-type')).toBe('application/octet-stream')
    expect(block.headers.get('cache-control')).toBe('private, no-store')
    // 合成素材第 2 层的存储值为 1025–1075，截距 -1024。
    expect(int16Values(await block.arrayBuffer())).toEqual([1, 11, 21, 31, 41, 51])

    // 越界的序列、帧或块不存在。
    for (const path of ['series/1/frames/0/blocks/0', 'series/0/frames/3/blocks/0', 'series/0/frames/0/blocks/1']) {
      const missing = await runtime.app.request(`${studyPath}/${path}`, { headers: { cookie: doctor } })
      expect(missing.status).toBe(404)
      expect(apiErrorSchema.parse(await missing.json()).error.code).toBe('IMAGING_STUDY_NOT_FOUND')
    }

    // 未登录、无关岗位、猜测的检查标识或素材标识都读不到像素。
    expect((await runtime.app.request(studyPath)).status).toBe(401)
    const registrar = await signIn(runtime, 'registrar@demo.clinmesh.local')
    for (const cookie of [registrar, administrator]) {
      expect((await runtime.app.request(studyPath, { headers: { cookie } })).status).toBe(403)
      expect((await runtime.app.request(`${studyPath}/series/0/frames/0/blocks/0`, { headers: { cookie } })).status)
        .toBe(403)
    }
    for (const guessed of [massCt, '00000000-0000-7000-8000-000000000000']) {
      const response = await runtime.app.request(`/api/his/v1/imaging-studies/${guessed}`, { headers: { cookie: doctor } })
      expect(response.status).toBe(404)
      expect((await runtime.app.request(
        `/api/his/v1/imaging-studies/${guessed}/series/0/frames/0/blocks/0`,
        { headers: { cookie: doctor } },
      )).status).toBe(404)
    }

    // 重置后旧 Epoch 的检查链接失效。
    expect((await runtime.app.request(
      '/api/sim/v1/scenario-runs/scenario-run-1/actions/reset',
      mutation(administrator, {}),
    )).status).toBe(200)
    const afterReset = await signIn(runtime, 'doctor@demo.clinmesh.local')
    expect((await runtime.app.request(studyPath, { headers: { cookie: afterReset } })).status).toBe(404)
    expect((await runtime.app.request(`${studyPath}/series/0/frames/0/blocks/0`, { headers: { cookie: afterReset } })).status)
      .toBe(404)
  })

  it('reports missing pixels as unavailable without failing the study description', async () => {
    const { assetDirectory, doctor, runtime, studyId } = await reportedCtStudy()
    await rm(join(assetDirectory, 'installed', massCt), { recursive: true })

    const described = await runtime.app.request(`/api/his/v1/imaging-studies/${studyId}`, { headers: { cookie: doctor } })
    expect(described.status).toBe(200)
    expect(imagingStudyViewSchema.parse(await described.json())).toEqual({
      available: false,
      examCode: 'chest-ct-plain',
      series: [],
      studyId,
    })
    const block = await runtime.app.request(
      `/api/his/v1/imaging-studies/${studyId}/series/0/frames/0/blocks/0`,
      { headers: { cookie: doctor } },
    )
    expect(block.status).toBe(409)
    expect(apiErrorSchema.parse(await block.json()).error.code).toBe('IMAGING_STUDY_UNAVAILABLE')
  })

  it('lets only the administrator preview a catalog asset for review', async () => {
    const { administrator, doctor, runtime } = await reportedCtStudy()
    const assetPath = `/api/sim/v1/admin/imaging-assets/${massRadiograph}`

    const described = await runtime.app.request(assetPath, { headers: { cookie: administrator } })
    expect(described.status).toBe(200)
    expect(described.headers.get('cache-control')).toBe('no-store')
    const preview = await described.json() as { study: unknown }
    expect(imagingStudyViewSchema.parse(preview.study)).toMatchObject({
      available: true,
      examCode: 'chest-radiograph',
      series: [{ frames: [{ columns: 3, rows: 2, view: 'frontal' }], kind: 'frame-stack', modality: 'DX' }],
      studyId: massRadiograph,
    })
    expect(preview).toMatchObject({
      annotation: { kind: 'lidc-radiograph' },
      assetId: massRadiograph,
      publication: { publishedRevisions: [1], reasons: [] },
      reports: [{ checkIssues: [], findings: '双肺野未见明确结节影。', revision: 1 }],
    })
    const block = await runtime.app.request(`${assetPath}/series/0/frames/0/blocks/0`, { headers: { cookie: administrator } })
    expect(block.status).toBe(200)
    expect(block.headers.get('content-type')).toBe('application/octet-stream')
    expect((await block.arrayBuffer()).byteLength).toBe(12)

    expect((await runtime.app.request(assetPath, { headers: { cookie: doctor } })).status).toBe(403)
    expect((await runtime.app.request(`${assetPath}/series/0/frames/0/blocks/0`, { headers: { cookie: doctor } })).status)
      .toBe(403)
    expect((await runtime.app.request(
      '/api/sim/v1/admin/imaging-assets/unknown-asset',
      { headers: { cookie: administrator } },
    )).status).toBe(404)
  })
})
