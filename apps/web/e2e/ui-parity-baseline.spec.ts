import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import {
  caseLaboratoryCatalogSearchSchema,
  clinicalDocumentDraftResponseSchema,
  clinicalDocumentSignPreviewResponseSchema,
  clinicalDocumentSignResponseSchema,
  confirmDiagnosisResponseSchema,
  diagnosisDraftResponseSchema,
  doctorCaseDetailSchema,
  issueLaboratoryRequestResponseSchema,
  issuePrescriptionResponseSchema,
  laboratoryRequestDraftResponseSchema,
  prescriptionDraftResponseSchema,
  registrationCatalogSchema,
  startVisitResponseSchema,
  triageResponseSchema,
} from '@clinmesh/contracts/his'
import { inpatientListSchema } from '@clinmesh/contracts/inpatient'
import { authoredCasePackSummarySchema, startSyntheticInpatientCaseResponseSchema } from '@clinmesh/contracts/inpatient-pci-data'
import { startSyntheticCaseResultSchema } from '@clinmesh/contracts/scenario'
import { expect, test } from './fixtures.ts'
import { selectInpatientStage, selectWorkspaceMode } from './inpatient-ui.ts'
import { openQueue } from './queue-overlay.fixture.ts'
import { diffPngBuffers } from './ui-parity-png.ts'
import { openWorkspaceTab } from './workspace-tabs.fixture.ts'

const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const BASELINE_DIR = join(REPO_ROOT, '.baseline-ui')
const SCREENSHOTS_DIR = join(BASELINE_DIR, 'screenshots')
const DIFFS_DIR = join(BASELINE_DIR, 'diffs')
const FINGERPRINT_PATH = join(BASELINE_DIR, 'style-fingerprint.json')
const REPORT_PATH = join(BASELINE_DIR, 'diff-report.json')

type BaselineMode = 'record' | 'compare' | 'auto'
const MODE: BaselineMode =
  process.env.UI_BASELINE_MODE === 'record'
    ? 'record'
    : process.env.UI_BASELINE_MODE === 'compare'
      ? 'compare'
      : 'auto'

const MAX_DIFF_RATIO = Number(process.env.UI_BASELINE_MAX_DIFF ?? '0.005')
const MAX_BODY_DIFF_RATIO = Number(process.env.UI_BASELINE_MAX_BODY_DIFF ?? '0.005')

interface StyleFingerprint {
  headerHeightPx: number
  buttonHeightsPx: { xs: number; sm: number; default: number; lg: number }
  smallControlRadiusPx: number
  inputRadiusPx: number
  cardRadiusPx: number
  bodyStandard: { fontSizePx: number; lineHeightPx: number }
  bodyLarger: { fontSizePx: number }
  bodyLarge: { fontSizePx: number }
  table: { fontSizePx: number; fontVariantNumeric: string }
  semanticColors: {
    light: { background: string; card: string; foreground: string; accentForeground: string }
    dark: { background: string; card: string; foreground: string; accentForeground: string }
  }
}

interface DiffEntry {
  name: string
  status: 'recorded' | 'passed' | 'failed' | 'skipped-no-baseline'
  diffPixels?: number
  totalPixels?: number
  diffRatio?: number
  bodyDiffPixels?: number
  bodyDiffRatio?: number
  dimensionMismatch?: boolean
}

const DISABLE_ANIMATION_CSS = `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
`

async function freezeVisuals(page: Page, options: { allowSkeleton?: boolean } = {}): Promise<void> {
  await page.addStyleTag({ content: DISABLE_ANIMATION_CSS }).catch(() => undefined)
  if (!options.allowSkeleton) {
    await expect(page.locator('[data-slot="skeleton"]')).toHaveCount(0, { timeout: 10_000 }).catch(() => undefined)
  }
  await page.evaluate(async () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    await document.fonts.ready
    await new Promise<void>(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(() => resolveFrame())))
  })
}

async function setPreferences(
  page: Page,
  prefs: { theme: 'light' | 'dark'; fontSize: 'standard' | 'larger' | 'large'; locale?: 'zh-CN' | 'en-US' },
  options: { allowSkeleton?: boolean } = {},
): Promise<void> {
  await page.evaluate(next => {
    localStorage.setItem('clinmesh.preferences:v1', JSON.stringify({
      fontSize: next.fontSize,
      locale: next.locale ?? 'zh-CN',
      theme: next.theme,
    }))
  }, prefs)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.locator('.clinmesh-web-root')).toBeVisible()
  await freezeVisuals(page, options)
}

async function loginRole(page: Page, origin: string, password: string, role: string, path: string): Promise<void> {
  await page.request.post(`${origin}/api/auth/sign-out`, { headers: { origin } })
  const response = await page.request.post(`${origin}/api/auth/sign-in/email`, {
    data: { email: `${role}@demo.clinmesh.local`, password },
    headers: { origin },
  })
  expect(response.status(), `login ${role}`).toBe(200)
  await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('button', { name: '用户菜单' })).toBeVisible()
  await freezeVisuals(page)
}

async function captureAndVerify(
  page: Page,
  name: string,
  report: DiffEntry[],
  options: { fullPage?: boolean; maxDiffRatio?: number; maxBodyDiffRatio?: number; allowSkeleton?: boolean } = {},
): Promise<void> {
  await freezeVisuals(page, { allowSkeleton: options.allowSkeleton })
  const actual = await page.screenshot({ animations: 'disabled', fullPage: options.fullPage ?? false })
  const baselinePath = join(SCREENSHOTS_DIR, `${name}.png`)

  if (MODE === 'record') {
    await mkdir(SCREENSHOTS_DIR, { recursive: true })
    await writeFile(baselinePath, actual)
    report.push({ name, status: 'recorded' })
    return
  }

  if (!existsSync(baselinePath)) {
    if (MODE === 'compare') {
      throw new Error(`Missing baseline screenshot: ${baselinePath}. Run with UI_BASELINE_MODE=record first.`)
    }
    report.push({ name, status: 'skipped-no-baseline' })
    return
  }

  const baseline = await readFile(baselinePath)
  const diff = diffPngBuffers(baseline, actual, { channelTolerance: 2, headerHeightPx: 49 })
  const allowedFull = options.maxDiffRatio ?? MAX_DIFF_RATIO
  const allowedBody = options.maxBodyDiffRatio ?? MAX_BODY_DIFF_RATIO
  const passed = !diff.dimensionMismatch && diff.diffRatio <= allowedFull && diff.bodyDiffRatio <= allowedBody

  if (diff.diffPng !== undefined) {
    await mkdir(DIFFS_DIR, { recursive: true })
    await writeFile(join(DIFFS_DIR, `${name}.diff.png`), diff.diffPng)
    await writeFile(join(DIFFS_DIR, `${name}.actual.png`), actual)
  }

  report.push({
    name,
    status: passed ? 'passed' : 'failed',
    diffPixels: diff.diffPixels,
    totalPixels: diff.totalPixels,
    diffRatio: Number(diff.diffRatio.toFixed(6)),
    bodyDiffPixels: diff.bodyDiffPixels,
    bodyDiffRatio: Number(diff.bodyDiffRatio.toFixed(6)),
    dimensionMismatch: diff.dimensionMismatch,
  })
}

async function collectCatalogMetrics(page: Page) {
  return page.evaluate(() => {
    const parsePx = (value: string) => Math.round(Number.parseFloat(value) * 100) / 100
    const root = document.querySelector<HTMLElement>('.clinmesh-web-root')!
    const rootStyle = getComputedStyle(root)
    const buttonsSection = document.querySelector('section[aria-labelledby="catalog-buttons-heading"]')!
    const sizeButtons = [...buttonsSection.querySelectorAll<HTMLButtonElement>('div:first-of-type button')]
    const heights = sizeButtons.map(button => Math.round(button.getBoundingClientRect().height))
    const input = document.querySelector<HTMLInputElement>('#catalog-chief-complaint')!
    const card = document.querySelector<HTMLElement>('[data-slot="card"]')!
    const table = document.querySelector<HTMLElement>('[data-slot="table"]')!
    const probe = document.createElement('div')
    probe.style.position = 'fixed'
    probe.style.left = '-9999px'
    probe.style.backgroundColor = 'var(--background)'
    probe.style.borderColor = 'var(--card)'
    probe.style.color = 'var(--foreground)'
    probe.style.outlineColor = 'var(--accent-foreground)'
    root.appendChild(probe)
    const probeStyle = getComputedStyle(probe)
    const colors = {
      background: probeStyle.backgroundColor,
      card: probeStyle.borderColor,
      foreground: probeStyle.color,
      accentForeground: probeStyle.outlineColor,
    }
    probe.remove()

    return {
      buttonHeightsPx: {
        xs: heights[0] ?? 0,
        sm: heights[1] ?? 0,
        default: heights[2] ?? 0,
        lg: heights[3] ?? 0,
      },
      smallControlRadiusPx: parsePx(getComputedStyle(sizeButtons[1]!).borderTopLeftRadius),
      inputRadiusPx: parsePx(getComputedStyle(input).borderTopLeftRadius),
      cardRadiusPx: parsePx(getComputedStyle(card).borderTopLeftRadius),
      bodyFontSizePx: parsePx(rootStyle.fontSize),
      bodyLineHeightPx: parsePx(rootStyle.lineHeight),
      tableFontSizePx: parsePx(getComputedStyle(table).fontSize),
      tableFontVariantNumeric: getComputedStyle(table).fontVariantNumeric,
      colors,
    }
  })
}

test('UI/UX 视觉基线与计算样式指纹冻结/对比', async ({ page, browserApp }) => {
  test.setTimeout(300_000)
  const { origin, password } = browserApp
  const report: DiffEntry[] = []
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))

  const apiPost = (path: string, data: unknown, method: 'POST' | 'PUT' = 'POST') =>
    page.request.fetch(`${origin}${path}`, {
      data,
      headers: { 'idempotency-key': randomUUID(), origin },
      method,
    })

  // 1. 组件全景页 (/components): Light/Dark × 3 字号 + 样式指纹采集
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin}/components`, { waitUntil: 'domcontentloaded' })
  await setPreferences(page, { theme: 'light', fontSize: 'standard' }, { allowSkeleton: true })
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const lightStandard = await collectCatalogMetrics(page)
  await captureAndVerify(page, 'components-light-standard-1440', report, { fullPage: true, allowSkeleton: true })

  await setPreferences(page, { theme: 'dark', fontSize: 'standard' }, { allowSkeleton: true })
  const darkStandard = await collectCatalogMetrics(page)
  await captureAndVerify(page, 'components-dark-standard-1440', report, { fullPage: true, allowSkeleton: true })

  await setPreferences(page, { theme: 'light', fontSize: 'larger' }, { allowSkeleton: true })
  const lightLarger = await collectCatalogMetrics(page)
  await captureAndVerify(page, 'components-light-larger-1440', report, { fullPage: true, allowSkeleton: true })

  await setPreferences(page, { theme: 'light', fontSize: 'large' }, { allowSkeleton: true })
  const lightLarge = await collectCatalogMetrics(page)
  await captureAndVerify(page, 'components-light-large-1440', report, { fullPage: true, allowSkeleton: true })

  // 恢复标准字号与亮色，准备全岗位临床数据（纯 Authored Case Pack + HIS API，零 Synthea / 零 LLM）
  await setPreferences(page, { theme: 'light', fontSize: 'standard' }, { allowSkeleton: true })

  // 2. 管理员准备 PCI 目录与 5 例固定专病病例包
  await loginRole(page, origin, password, 'admin', '/scenario-data')
  const prepRegion = page.getByRole('region', { name: 'PCI 演示准备', exact: true })
  await expect(prepRegion).toBeVisible()
  await prepRegion.getByRole('button', { name: '准备 PCI 目录', exact: true }).click()
  await expect(prepRegion.getByRole('status').filter({ hasText: '目录已准备' })).toBeVisible()
  await prepRegion.getByRole('button', { name: '准备专病病例包（5 例）', exact: true }).click()
  await expect(prepRegion.getByRole('status').filter({ hasText: '5/5 已就绪' })).toBeVisible()

  const headerHeightPx = await page.evaluate(() => Math.round(document.querySelector('header')!.getBoundingClientRect().height))

  const fingerprint: StyleFingerprint = {
    headerHeightPx,
    buttonHeightsPx: lightStandard.buttonHeightsPx,
    smallControlRadiusPx: lightStandard.smallControlRadiusPx,
    inputRadiusPx: lightStandard.inputRadiusPx,
    cardRadiusPx: lightStandard.cardRadiusPx,
    bodyStandard: {
      fontSizePx: lightStandard.bodyFontSizePx,
      lineHeightPx: lightStandard.bodyLineHeightPx,
    },
    bodyLarger: { fontSizePx: lightLarger.bodyFontSizePx },
    bodyLarge: { fontSizePx: lightLarge.bodyFontSizePx },
    table: {
      fontSizePx: lightStandard.tableFontSizePx,
      fontVariantNumeric: lightStandard.tableFontVariantNumeric,
    },
    semanticColors: {
      light: lightStandard.colors,
      dark: darkStandard.colors,
    },
  }

  // 硬性设计合同指纹断言
  expect(fingerprint.headerHeightPx).toBe(48)
  expect(fingerprint.buttonHeightsPx).toEqual({ xs: 24, sm: 28, default: 32, lg: 36 })
  expect(fingerprint.smallControlRadiusPx).toBe(6)
  expect(fingerprint.inputRadiusPx).toBe(8)
  expect(fingerprint.cardRadiusPx).toBe(8)
  expect(fingerprint.bodyStandard).toEqual({ fontSizePx: 14, lineHeightPx: 21 })
  expect(fingerprint.bodyLarger.fontSizePx).toBe(15.75)
  expect(fingerprint.bodyLarge.fontSizePx).toBe(17.5)
  expect(fingerprint.table.fontSizePx).toBe(13)
  expect(fingerprint.table.fontVariantNumeric).toContain('tabular-nums')
  expect(fingerprint.semanticColors.light).toEqual({
    background: 'rgb(245, 246, 247)',
    card: 'rgb(255, 255, 255)',
    foreground: 'rgb(15, 17, 21)',
    accentForeground: 'rgb(23, 95, 184)',
  })

  if (MODE === 'record') {
    await mkdir(BASELINE_DIR, { recursive: true })
    await writeFile(FINGERPRINT_PATH, `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf8')
  } else if (existsSync(FINGERPRINT_PATH)) {
    const expectedFingerprint = JSON.parse(await readFile(FINGERPRINT_PATH, 'utf8')) as StyleFingerprint
    expect(fingerprint).toEqual(expectedFingerprint)
  } else if (MODE === 'compare') {
    throw new Error(`Missing style fingerprint baseline: ${FINGERPRINT_PATH}`)
  }

  // 管理员页面截图 (Light / Dark)
  await captureAndVerify(page, 'admin-scenario-data-light-1440', report)
  await setPreferences(page, { theme: 'dark', fontSize: 'standard' })
  await captureAndVerify(page, 'admin-scenario-data-dark-1440', report)
  await setPreferences(page, { theme: 'light', fontSize: 'standard' })

  const packSummary = authoredCasePackSummarySchema.parse(
    await (await page.request.get(`${origin}/api/sim/v1/synthetic-cases/authored-pack`)).json(),
  )
  expect(packSummary.readyCount).toBe(5)
  const opCase = packSummary.cases.find(item => item.draftId === 'renal-t2dm-htn-ckd4-control-v1')!.case!
  const ipCase = packSummary.cases.find(item => item.draftId === 'cardio-cad-ckd3b-hydration-pci-v1')!.case!

  // 3. 挂号员发起门诊 & 住院病例
  await loginRole(page, origin, password, 'registrar', '/registration')
  const regCat = registrationCatalogSchema.parse(await (await page.request.get(`${origin}/api/his/v1/catalogs/registration`)).json())
  const startedOp = startSyntheticCaseResultSchema.parse((await (await apiPost(
    `/api/his/v1/synthetic-cases/${opCase.caseId}/actions/start-outpatient-visit`,
    {
      activeBriefRevision: opCase.activeBriefRevision!,
      departmentId: regCat.departments[0]!.id,
      expectedCaseRevision: opCase.revision,
      locationId: regCat.locations[0]!.id,
      visitDate: regCat.virtualDate,
      visitTypeId: regCat.visitTypes[0]!.id,
    },
  )).json()).data)

  const startedIp = startSyntheticInpatientCaseResponseSchema.parse(await (await apiPost(
    `/api/his/v1/synthetic-cases/${ipCase.caseId}/actions/start-inpatient-visit`,
    {
      activeBriefRevision: ipCase.activeBriefRevision!,
      expectedCaseRevision: ipCase.revision,
      expectedEpoch: 'epoch-1',
      wardId: 'ward-general',
    },
  )).json()).data

  await page.reload({ waitUntil: 'domcontentloaded' })
  await captureAndVerify(page, 'registrar-outpatient-light-1440', report)
  await setPreferences(page, { theme: 'dark', fontSize: 'standard' })
  await captureAndVerify(page, 'registrar-outpatient-dark-1440', report)
  await setPreferences(page, { theme: 'light', fontSize: 'standard' })

  // 4. 分诊护士工作台 (/triage)
  await loginRole(page, origin, password, 'triage', '/triage')
  await captureAndVerify(page, 'triage-light-1440', report)
  await setPreferences(page, { theme: 'dark', fontSize: 'standard' })
  await captureAndVerify(page, 'triage-dark-1440', report)
  await setPreferences(page, { theme: 'light', fontSize: 'standard' })

  const triagedOp = triageResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/actions/record-triage`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: '1', [`Task/${startedOp.queueTaskId}`]: '1' },
      input: {
        acuityCode: 'level-3',
        bloodPressure: { diastolicMmHg: 78, systolicMmHg: 132 },
        chiefComplaint: '高血压合并血脂异常复诊开药',
        oxygenSaturationPct: 98,
        pulseBpm: 72,
        respirationBpm: 18,
        temperatureC: 36.5,
      },
    },
  )).json()).data

  // 5. 门诊医生工作台 (/consultation): 5 个页签 + 开单两栏弹窗 + 3 视口 + Light/Dark + 3 字号
  await loginRole(page, origin, password, 'doctor', '/consultation')
  startVisitResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/actions/start-first-visit`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: '2', [`Task/${triagedOp.doctorTaskId}`]: '1' },
      input: {},
    },
  )).json())

  const readOp = async () => doctorCaseDetailSchema.parse(
    await (await page.request.get(`${origin}/api/his/v1/doctor/cases/${startedOp.outpatientCaseId}`)).json(),
  )
  const d1 = await readOp()
  const docDraft = clinicalDocumentDraftResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/clinical-document/draft`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d1.encounter.versionId },
      input: {
        document: {
          assessment: '高血压合并血脂异常，评估肾功能并续方调压调脂。',
          chiefComplaint: '高血压合并血脂异常复诊开药。',
          disposition: '门诊完善化验并规律口服降压药物。',
          followUp: '4 周后复查血压、血脂与肾功能。',
          historyOfPresentIllness: '既往高血压、血脂异常及慢性肾脏病史，来院复诊。',
          menstrualHistory: '已绝经。',
          obstetricHistory: '孕2产2。',
          physicalExamination: '神清，血压 132/78 mmHg，双肺呼吸音清。',
        },
        expectedDraftVersion: 0,
      },
    },
    'PUT',
  )).json()).data
  const d2 = await readOp()
  const signPrev = clinicalDocumentSignPreviewResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/clinical-document/actions/preview-sign`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d2.encounter.versionId },
      input: { expectedDraftVersion: docDraft.draftVersion },
    },
  )).json()).data
  const d3 = await readOp()
  clinicalDocumentSignResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/clinical-document/actions/sign`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d3.encounter.versionId },
      input: { commitToken: signPrev.commitToken, previewId: signPrev.previewId },
    },
  )).json())

  const d4 = await readOp()
  const diagDraft = diagnosisDraftResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/diagnosis/draft`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d4.encounter.versionId },
      input: {
        entries: [{ catalogItemId: 'diagnosis-hypertension', role: 'primary' }],
        expectedDraftVersion: 0,
      },
    },
    'PUT',
  )).json()).data
  confirmDiagnosisResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/diagnosis/actions/confirm`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d4.encounter.versionId },
      input: { expectedDraftVersion: diagDraft.draftVersion },
    },
  )).json())

  const caseLabs = caseLaboratoryCatalogSearchSchema.parse(
    await (await page.request.get(`${origin}/api/his/v1/doctor/cases/${startedOp.outpatientCaseId}/reference-catalogs/laboratory?page=1&pageSize=20`)).json(),
  )
  const firstLab = caseLabs.items.find(item => item.allowedIndicationCodes.length > 0)
  if (firstLab !== undefined) {
    const dLab = await readOp()
    const labDraftRes = await apiPost(
      `/api/his/v1/encounters/${startedOp.encounterId}/laboratory-request/draft`,
      {
        expectedVersions: { [`Encounter/${startedOp.encounterId}`]: dLab.encounter.versionId },
        input: {
          catalogItemId: firstLab.id,
          expectedDraftVersion: dLab.laboratoryRequests?.draftVersion ?? 0,
          indicationCode: firstLab.allowedIndicationCodes[0]!,
        },
      },
      'PUT',
    )
    expect(labDraftRes.status(), await labDraftRes.text()).toBe(200)
    const labDraft = laboratoryRequestDraftResponseSchema.parse(await labDraftRes.json()).data
    const labIssueRes = await apiPost(
      `/api/his/v1/encounters/${startedOp.encounterId}/laboratory-request/actions/issue`,
      {
        expectedVersions: { [`Encounter/${startedOp.encounterId}`]: dLab.encounter.versionId },
        input: { expectedDraftVersion: labDraft.draftVersion },
      },
    )
    expect(labIssueRes.status(), await labIssueRes.text()).toBe(200)
    issueLaboratoryRequestResponseSchema.parse(await labIssueRes.json())
  }

  const d5 = await readOp()
  const rxDraft = prescriptionDraftResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/prescription/draft`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d5.encounter.versionId },
      input: {
        expectedDraftVersion: 0,
        items: [{ catalogItemId: 'medication-amlodipine', courseDays: 14, doseText: '5 mg', frequencyCode: 'QD', quantity: 14, routeCode: 'PO' }],
      },
    },
    'PUT',
  )).json()).data
  issuePrescriptionResponseSchema.parse(await (await apiPost(
    `/api/his/v1/encounters/${startedOp.encounterId}/prescription/actions/issue`,
    {
      expectedVersions: { [`Encounter/${startedOp.encounterId}`]: d5.encounter.versionId },
      input: { expectedDraftVersion: rxDraft.draftVersion },
    },
  )).json())

  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('region', { name: '当前患者', exact: true })).toBeVisible()

  // 医生工作台五页签（1440×900 Light）
  await openWorkspaceTab(page, '问诊记录')
  await captureAndVerify(page, 'doctor-tab-consultation-light-1440', report)

  await openWorkspaceTab(page, '病历记录')
  await captureAndVerify(page, 'doctor-tab-record-light-1440', report)

  await openWorkspaceTab(page, '诊断')
  await captureAndVerify(page, 'doctor-tab-diagnosis-light-1440', report)

  await openWorkspaceTab(page, '检验检查')
  await captureAndVerify(page, 'doctor-tab-lab-light-1440', report)

  await openWorkspaceTab(page, '处方')
  await captureAndVerify(page, 'doctor-tab-prescription-light-1440', report)

  // 开单两栏 Dialog（选择诊断）
  await openWorkspaceTab(page, '诊断')
  await page.locator('[data-agent-section="diagnosis"]').getByRole('button', { name: '添加诊断', exact: true }).click()
  await expect(page.getByRole('dialog', { name: '选择诊断', exact: true })).toBeVisible()
  await captureAndVerify(page, 'doctor-dialog-diagnosis-light-1440', report)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  // 医生工作台多主题、多字号、多视口矩阵
  await setPreferences(page, { theme: 'dark', fontSize: 'standard' })
  await openWorkspaceTab(page, '病历记录')
  await captureAndVerify(page, 'doctor-tab-record-dark-1440', report)

  await setPreferences(page, { theme: 'light', fontSize: 'larger' })
  await openWorkspaceTab(page, '病历记录')
  await captureAndVerify(page, 'doctor-tab-record-light-larger-1440', report)

  await setPreferences(page, { theme: 'light', fontSize: 'large' })
  await openWorkspaceTab(page, '病历记录')
  await captureAndVerify(page, 'doctor-tab-record-light-large-1440', report)

  await setPreferences(page, { theme: 'light', fontSize: 'standard' })
  await page.setViewportSize({ width: 1024, height: 768 })
  await openWorkspaceTab(page, '诊断')
  await captureAndVerify(page, 'doctor-tab-diagnosis-light-1024', report)

  await page.setViewportSize({ width: 720, height: 900 })
  await expect(page.getByRole('button', { name: '展开队列', exact: true })).toBeVisible()
  await captureAndVerify(page, 'doctor-narrow-collapsed-light-720', report)
  await openQueue(page)
  await captureAndVerify(page, 'doctor-narrow-drawer-open-light-720', report)
  await page.setViewportSize({ width: 1440, height: 900 })

  // 6. 收费员工作台 (/billing) + 多费用合并收款弹窗
  await loginRole(page, origin, password, 'cashier', '/billing')
  await expect(page.getByRole('heading', { name: '门诊收费', exact: true })).toBeVisible()
  await captureAndVerify(page, 'cashier-billing-light-1440', report)
  await setPreferences(page, { theme: 'dark', fontSize: 'standard' })
  await captureAndVerify(page, 'cashier-billing-dark-1440', report)
  await setPreferences(page, { theme: 'light', fontSize: 'standard' })

  const multiChargeButton = page.getByRole('button', { name: /选择多项收费|多费用合并收款|合并收款/ }).first()
  await expect(multiChargeButton).toBeVisible()
  await multiChargeButton.click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await captureAndVerify(page, 'cashier-multi-charge-dialog-light-1440', report)
  await page.keyboard.press('Escape')

  // 7. 药师工作台 (/pharmacy)
  await loginRole(page, origin, password, 'pharmacist', '/pharmacy')
  await captureAndVerify(page, 'pharmacy-light-1440', report)
  await setPreferences(page, { theme: 'dark', fontSize: 'standard' })
  await captureAndVerify(page, 'pharmacy-dark-1440', report)
  await setPreferences(page, { theme: 'light', fontSize: 'standard' })

  // 8. 住院工作台：病区护士接收入科 + 住院医生查看阶段页签与手术/医嘱界面
  await loginRole(page, origin, password, 'ward-nurse', '/inpatient')
  const listForNurse = inpatientListSchema.parse(await (await page.request.get(`${origin}/api/his/v1/inpatient/admissions`)).json())
  const regAdm = listForNurse.items.find(item => item.id === startedIp.admissionId)!
  expect((await apiPost(`/api/his/v1/inpatient/admissions/${startedIp.admissionId}/receive`, {
    input: { bedId: 'bed-general-1', encounterVersion: regAdm.versionId },
  })).status()).toBe(200)

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: new RegExp(regAdm.patientName) }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toBeVisible()
  await captureAndVerify(page, 'inpatient-ward-nurse-light-1440', report)

  await loginRole(page, origin, password, 'inpatient-doctor', '/inpatient')
  await page.getByRole('button', { name: new RegExp(regAdm.patientName) }).click()
  await expect(page.getByRole('region', { name: '当前住院患者', exact: true })).toBeVisible()
  await captureAndVerify(page, 'inpatient-doctor-orders-light-1440', report)

  await selectInpatientStage(page, '手术')
  await captureAndVerify(page, 'inpatient-doctor-surgery-light-1440', report)

  await setPreferences(page, { theme: 'dark', fontSize: 'standard' })
  await page.getByRole('button', { name: new RegExp(regAdm.patientName) }).click()
  await captureAndVerify(page, 'inpatient-doctor-orders-dark-1440', report)

  await setPreferences(page, { theme: 'light', fontSize: 'standard' })
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.getByRole('button', { name: new RegExp(regAdm.patientName) }).click()
  await captureAndVerify(page, 'inpatient-doctor-orders-light-1024', report)

  await page.setViewportSize({ width: 720, height: 900 })
  await expect(page.getByRole('button', { name: '展开队列', exact: true })).toBeVisible()
  await captureAndVerify(page, 'inpatient-doctor-narrow-light-720', report)

  // 回到 1440 测住院收费页
  await page.setViewportSize({ width: 1440, height: 900 })
  await loginRole(page, origin, password, 'cashier', '/billing')
  await selectWorkspaceMode(page, '住院')
  await captureAndVerify(page, 'cashier-inpatient-light-1440', report)

  await mkdir(BASELINE_DIR, { recursive: true })
  await writeFile(REPORT_PATH, `${JSON.stringify({ mode: MODE, maxDiffRatio: MAX_DIFF_RATIO, maxBodyDiffRatio: MAX_BODY_DIFF_RATIO, items: report }, null, 2)}\n`, 'utf8')

  expect(errors).toEqual([])
  const failures = report.filter(item => item.status === 'failed')
  expect(failures, `Visual baseline diff exceeded threshold:\n${JSON.stringify(failures, null, 2)}`).toEqual([])
})
