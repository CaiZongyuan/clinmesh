// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionContext } from '@clinmesh/contracts/his'
import { inpatientAdmissionSchema } from '@clinmesh/contracts/inpatient'
import { inpatientFullClinicalSchema } from '@clinmesh/contracts/inpatient-clinical'
import { inpatientMaterialEstimateSchema } from '@clinmesh/contracts/inpatient-material-estimate'
import { InpatientSurgery } from './inpatient-surgery.tsx'
import { InpatientActionProvider, InpatientActionOutlet } from './inpatient-workspace-actions.tsx'
import { useInpatientWriteIntent } from './inpatient-write-intent.ts'

const time = '2026-11-13T09:00:00+08:00'
const session: SessionContext = { actor: { actorId: 'doctor', workspaceId: 'workspace-demo', epoch: 'epoch-1', scenarioRunId: 'run-1', practitionerRoleId: 'role-doctor', roleCode: 'inpatient-doctor' }, user: { id: 'doctor', name: '住院医生', email: 'doctor@demo.clinmesh.local' }, availableRoles: [] }
const admission = inpatientAdmissionSchema.parse({ id: 'admission-1', patientId: 'patient-1', patientName: '合成患者', inpatientNumber: 'ZY-001', admissionRoute: 'direct', wardId: 'ward-1', organizationId: 'org-1', status: 'admitted', financialStatus: 'open', recordStatus: 'open', registeredAt: time, depositFen: 0, chargesFen: 0, versionId: '1' })
const procedure = { id: 'procedure-1', version: 1, coding: { system: 'urn:clinmesh:classification:icd-9-cm-3-clinical', version: '3.0', code: '88.5500', display: '用单根导管的冠状动脉造影术', category: '诊断性操作', releaseId: 'clinmesh-surgery-subset-2026-10-20', sourceUrl: 'https://example.com/synthetic', sourceSha256: 'a'.repeat(64), sourceLocator: 'synthetic' }, chargeDefinition: { id: 'procedure-price', priceFen: 10000, unit: '次', synthetic: true, trigger: 'execution' } }
const otherProcedure = { ...procedure, id: 'procedure-2', coding: { ...procedure.coding, code: '36.0700', display: '药物洗脱冠状动脉支架置入术', category: '介入治疗' as const } }
const material = { id: 'material-1', version: 1, display: '合成造影导管', chargeDefinition: { id: 'material-price', priceFen: 2000, unit: '根', synthetic: true, trigger: 'execution' } }
const plan = { id: 'request-1', admissionId: admission.id, version: 3, status: 'ready', plannedProcedure: procedure, plannedFor: time, preopOrderPolicy: 'continue-active' as const, reason: '合成冠脉造影计划', requestedAt: time, requestedBy: 'doctor', organizationId: 'org-1', consentConfirmation: { actorId: 'doctor', practitionerRoleId: 'role-doctor', recordedAt: time, note: '已核实同意书' }, preopCheck: { actorId: 'nurse', practitionerRoleId: 'role-nurse', recordedAt: time, note: '已核对' } }
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); sessionStorage.clear() })

function mount({ consent = true, stale = true, pci = false, changed = false, clinicalFailOnce = false, withCompletedAngio = false, roleCode = 'inpatient-doctor' as SessionContext['actor']['roleCode'] } = {}) {
  const currentSession: SessionContext = { ...session, actor: { ...session.actor, roleCode, practitionerId: roleCode === 'inpatient-doctor' ? 'practitioner-inpatient-doctor' : 'practitioner-ward-nurse' } }
  let failedClinical = false
  const completedReq = {
    ...plan,
    id: 'request-completed-angio',
    status: 'completed' as const,
    surgeryType: 'elective' as const,
    location: { id: 'location-catheterization-lab' as const, name: '导管室' },
    surgeon: { id: 'practitioner-surgeon-chief', name: '林海', title: '主任医师' },
    anesthesiaMethod: 'local-infiltration' as const,
    consentConfirmation: {
      ...plan.consentConfirmation,
      document: {
        templateId: 'coronary-angiography' as const,
        templateVersion: '2026-11-23.r1' as const,
        title: '冠状动脉造影术知情同意书',
        disclaimer: '合成临床教学文书模板，仅供仿真演练使用，非真实医疗法律文书' as const,
        patient: { name: admission.patientName, gender: 'female' as const, birthDate: '1980-01-01', inpatientNumber: admission.inpatientNumber },
        primaryDiagnosis: { code: 'I20.000', display: '不稳定型心绞痛' },
        surgeryNotice: {
          surgeryType: 'elective' as const,
          procedureCode: '88.5500',
          procedureDisplay: '用单根导管的冠状动脉造影术',
          plannedFor: time,
          locationName: '导管室',
          anesthesiaMethod: 'local-infiltration' as const,
          surgeonName: '林海（主任医师）',
          assistantName: null,
        },
        purposeAndMethod: '经桡动脉穿刺行冠状动脉造影检查。',
        commonRisks: ['穿刺部位出血血肿。', '对比剂过敏与对比剂肾损伤。', '冠状动脉痉挛或夹层。'],
        individualizedRisks: null,
        alternativePlans: 'CCTA 或药物保守治疗。',
        patientChoiceStatement: '患者已知情并同意实施检查。',
        signature: {
          signerRole: 'patient' as const,
          signerName: admission.patientName,
          signerRelationship: null,
          patientChoice: 'agree' as const,
          talkingDoctorId: 'practitioner-inpatient-doctor',
          talkingDoctorName: '住院医生（主治医师）',
          signedAt: time,
        },
        renderedText: '冠状动脉造影术知情同意书全文快照',
      },
    },
  }
  const completedExec = {
    id: 'exec-completed-angio',
    admissionId: admission.id,
    requestId: completedReq.id,
    actualProcedure: procedure,
    performedAt: time,
    completedAt: time,
    performedBy: 'doctor',
    practitionerRoleId: 'role-doctor',
    organizationId: 'org-1',
    note: '冠脉造影已完成',
    materials: [],
    materialHistory: [],
  }
  const estimate = inpatientMaterialEstimateSchema.parse({ id: 'estimate-1', admissionId: admission.id, requestId: plan.id, version: 1, requestVersion: 3,
    status: stale ? 'stale' : 'succeeded', basisFingerprint: 'a'.repeat(64), failureCode: null, missing: [], candidates: [], analysis: null, candidateItems: [],
    draft: { revision: 1, basisFingerprint: 'b'.repeat(64), analysisId: null, items: [{ materialId: material.id, catalogVersion: 1, quantity: 1, reason: '按造影方案' }], note: '', edited: false, updatedAt: time, updatedBy: 'doctor', confirmedRevision: 1, reservationIds: ['reservation-1'] } })
  vi.stubGlobal('fetch', vi.fn(async (path: string) => {
    if (path.endsWith('/api/auth/context')) return Response.json(currentSession)
    if (path.endsWith('/clinical')) {
      if (clinicalFailOnce && !failedClinical) {
        failedClinical = true
        return Response.json({ error: { code: 'UNAVAILABLE', message: '合成诊断暂时读取失败' } }, { status: 503 })
      }
      return Response.json(inpatientFullClinicalSchema.parse({
        admissionId: admission.id,
        encounterVersion: '1',
        diagnosis: {
          revision: 1,
          entries: [{
            conditionId: 'cond-1',
            role: 'primary',
            admissionCondition: '1',
            ordinal: 1,
            coding: {
              id: 'diagnosis-1',
              system: 'urn:clinmesh:reference:nhsa-diagnosis',
              version: '2022',
              code: 'I20.000',
              display: '不稳定型心绞痛',
              releaseId: 'clinmesh-icd10-2026',
              sourceLocator: 'cn-health:diagnosis:1',
            },
          }],
        },
        orders: [],
        executions: [],
        dispenses: [],
        charges: [],
        chargesFen: 0,
      }))
    }
    if (path.endsWith('/surgeries')) return Response.json({
      admissionId: admission.id,
      encounterVersion: '1',
      virtualTime: time,
      requests: [
        ...(withCompletedAngio ? [completedReq] : []),
        { ...plan, plannedProcedure: pci ? otherProcedure : procedure, status: consent ? 'ready' : 'requested', consentConfirmation: consent ? plan.consentConfirmation : undefined },
      ],
      executions: withCompletedAngio ? [completedExec] : [],
      inProgress: [],
    })
    if (path.endsWith('/surgery-catalog')) return Response.json({
      procedures: [procedure, otherProcedure],
      materials: [material],
      locations: [
        { id: 'location-catheterization-lab', name: '导管室', nameEn: 'Catheterization Lab' },
        { id: 'location-operating-center', name: '中心手术室', nameEn: 'Operating Center' },
      ],
      practitioners: [
        { id: 'practitioner-inpatient-doctor', name: '住院医生', title: '主治医师' },
        { id: 'practitioner-surgeon-chief', name: '林海', title: '主任医师' },
      ],
    })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservationSets: [], reservations: [{ id: 'reservation-1', admissionId: admission.id, requestId: plan.id, materialId: material.id, materialDisplay: material.display, quantity: 1, catalogVersion: 1, consumedQuantity: 0, priceFen: 2000, status: 'reserved', reason: '按造影方案', createdAt: time }] })
    if (path.endsWith('/pci-selection')) return Response.json({ admissionId: admission.id, confirmation: null, history: [], evidencePackage: { id: 'synthetic-evidence', version: '1', synthetic: true, limitation: '仅合成验证' }, candidates: [], drafts: [{ requestId: plan.id, version: 1, reportId: 'report-1', reportVersion: 1, edited: changed, confirmedSelectionVersion: changed ? null : 1, parameters: { requestId: plan.id, treatmentPlan: '支架置入', targetSite: 'LAD', measurements: [], plannedQuantities: [], approvedMaterialIds: [] } }] })
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [estimate], unprepared: [] })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料未准备' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); clients.push(client)
  function Harness() { const write = useInpatientWriteIntent(currentSession, () => undefined); return <InpatientActionProvider stage="surgery"><InpatientSurgery admission={admission} session={currentSession} locale="zh-CN" write={write} /><InpatientActionOutlet /></InpatientActionProvider> }
  return render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
}

it('预留后通用费用依据失效不误报选型变化，重新进入仍可开始手术', async () => {
  mount()
  await screen.findByRole('region', { name: '手术耗材' })
  await screen.findByText(/已为本计划预留/)
  expect(screen.queryByText(/选型已变化/)).toBeNull()
  const action = screen.getByRole('region', { name: '当前操作' })
  expect(within(action).getByRole('button', { name: '开始手术' }).hasAttribute('disabled')).toBe(false)
})

it('一术一议知情同意书弹窗展示术式专有风险，支持本人或委托签署并拦截空签署人与缺关系提交', async () => {
  mount({ consent: false, stale: false })
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '确认已签' }))
  const dialog = await screen.findByRole('dialog', { name: '手术知情同意书' })
  const article = await within(dialog).findByRole('article', { name: '冠状动脉造影术知情同意书' })
  expect(article.textContent).toContain('含碘对比剂')
  expect(article.textContent).toContain('I20.000 不稳定型心绞痛')
  expect(article.textContent).toContain('住院医生（主治医师）')
  const signerField = within(dialog).getByLabelText('签署人姓名')
  expect(signerField).toHaveProperty('value', admission.patientName)
  expect(within(dialog).getByRole('button', { name: '确认手术知情同意书已签' }).hasAttribute('disabled')).toBe(false)
  await user.clear(signerField)
  expect(within(dialog).getByRole('button', { name: '确认手术知情同意书已签' }).hasAttribute('disabled')).toBe(true)
  within(dialog).getByRole('combobox', { name: '签署人身份' }).focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: '患者近亲属/受托人' }))
  await user.type(within(dialog).getByLabelText('签署人姓名'), '张受托')
  expect(within(dialog).getByRole('button', { name: '确认手术知情同意书已签' }).hasAttribute('disabled')).toBe(true)
  await user.click(within(dialog).getByRole('button', { name: '配偶' }))
  expect(within(dialog).getByLabelText('与患者关系')).toHaveProperty('value', '配偶')
  await user.type(within(dialog).getByLabelText('个体化特别风险说明'), '合并肾功能减退，需水化预防肾损伤')
  expect(within(dialog).getByRole('button', { name: '确认手术知情同意书已签' }).hasAttribute('disabled')).toBe(false)
})

it('知情同意书弹窗在住院诊断读取失败时阻断提交并提示重试，避免误显示未确认主诊断；后续存在待准备计划时医护仍可展开已完成手术查看六要素与同意书', async () => {
  const first = mount({ consent: false, stale: false, clinicalFailOnce: true, withCompletedAngio: true })
  const user = userEvent.setup()
  await user.click(await screen.findByText(/已完成手术记录（1）/, { selector: 'summary' }))
  expect(screen.getByText('林海（主任医师）')).toBeDefined()
  expect(screen.getByRole('button', { name: '查看知情同意书' })).toBeDefined()

  await user.click(await screen.findByRole('button', { name: '确认已签' }))
  const dialog = await screen.findByRole('dialog', { name: '手术知情同意书' })
  expect((await within(dialog).findByRole('alert')).textContent).toContain('住院诊断读取失败')
  expect(within(dialog).queryByText(/尚未确认住院主诊断/)).toBeNull()
  expect(within(dialog).getByRole('button', { name: '确认手术知情同意书已签' }).hasAttribute('disabled')).toBe(true)
  await user.click(within(dialog).getByRole('button', { name: '重试诊断信息' }))
  const article = await within(dialog).findByRole('article', { name: '冠状动脉造影术知情同意书' })
  expect(article.textContent).toContain('I20.000 不稳定型心绞痛')
  expect(within(dialog).getByRole('button', { name: '确认手术知情同意书已签' }).hasAttribute('disabled')).toBe(false)
  first.unmount()

  mount({ consent: true, stale: false, pci: true, withCompletedAngio: true, roleCode: 'ward-nurse' })
  const summary = await screen.findByText(/已完成手术记录（1）/, { selector: 'summary' })
  await user.click(summary)
  const completedDetails = summary.closest('details')!
  expect(within(completedDetails).getByText('林海（主任医师）')).toBeDefined()
  await user.click(within(completedDetails).getByRole('button', { name: '查看知情同意书' }))
  const preview = await screen.findByRole('dialog', { name: '冠状动脉造影术知情同意书' })
  expect(preview.textContent).toContain('经桡动脉穿刺行冠状动脉造影检查')
})

it('预留后真实修改 PCI 选型仍提示再次核对手术耗材', async () => {
  mount({ pci: true, changed: true })
  expect(await screen.findByText(/选型已变化/)).toBeDefined()
  expect(within(screen.getByRole('region', { name: '当前操作' })).getByRole('button', { name: '确认手术耗材' })).toBeDefined()
})

it('按计划术式开始默认折叠备注并可直接提交，改换实际术式自动展开并强制填写原因', async () => {
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: '开始手术' }))
  const dialog = await screen.findByRole('dialog', { name: '开始手术' })
  expect(within(dialog).queryByRole('textbox', { name: '开始说明' })).toBeNull()
  expect(within(dialog).getByRole('button', { name: '开始手术' }).hasAttribute('disabled')).toBe(false)
  await user.click(within(dialog).getByRole('button', { name: '添加备注' }))
  await user.click(within(dialog).getByRole('button', { name: '术前准备已完成，按计划开始手术' }))
  const input = within(dialog).getByRole('textbox', { name: '开始说明' })
  expect(input).toHaveProperty('value', '术前准备已完成，按计划开始手术')
  await user.clear(input)
  expect(within(dialog).getByRole('button', { name: '开始手术' }).hasAttribute('disabled')).toBe(false)
  within(dialog).getByRole('combobox', { name: '实际术式' }).focus()
  await user.keyboard('{Enter}')
  await user.click(await screen.findByRole('option', { name: '36.0700 · 药物洗脱冠状动脉支架置入术' }))
  expect(within(dialog).getByRole('textbox', { name: '开始说明' })).toBeDefined()
  expect(within(dialog).getByRole('button', { name: '开始手术' }).hasAttribute('disabled')).toBe(true)
  await user.type(within(dialog).getByRole('textbox', { name: '开始说明' }), '造影发现重度狭窄改为支架置入')
  expect(within(dialog).getByRole('button', { name: '开始手术' }).hasAttribute('disabled')).toBe(false)
})

it('目录无可用手术地点或无可选医师时不伪造兜底选项并阻断提交，签署同意书绑定所审阅的诊断修订版本并在冲突后刷新重签', async () => {
  const currentSession: SessionContext = { ...session, actor: { ...session.actor, practitionerId: 'practitioner-inpatient-doctor' } }
  let emptyLocations = true
  let diagnosisRevision = 1
  let requestVersion = 3
  const confirmCalls: Array<Record<string, unknown>> = []
  vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/api/auth/context')) return Response.json(currentSession)
    if (path.endsWith('/surgeries/confirm-consent') && init?.method === 'POST') {
      const payload = JSON.parse(String(init.body ?? '{}')) as { input: Record<string, unknown> }
      confirmCalls.push(payload.input)
      if (payload.input.expectedDiagnosisRevision !== diagnosisRevision || payload.input.expectedRequestVersion !== requestVersion) {
        return Response.json({ error: { code: 'INPATIENT_SURGERY_CONFLICT', message: '手术准备或诊断状态已更新，请重新核对后再确认签署' } }, { status: 409 })
      }
      return Response.json({
        auditId: '019a0000-0000-7000-8000-000000000091',
        correlationId: '019a0000-0000-7000-8000-000000000092',
        effects: [],
        data: {
          admissionId: admission.id,
          encounterVersion: '1',
          virtualTime: time,
          requests: [{ ...plan, version: requestVersion + 1, status: 'ready' }],
          executions: [],
          inProgress: [],
        },
      })
    }
    if (path.endsWith('/clinical')) {
      return Response.json(inpatientFullClinicalSchema.parse({
        admissionId: admission.id,
        encounterVersion: '1',
        diagnosis: {
          revision: diagnosisRevision,
          entries: [{
            conditionId: 'cond-1',
            role: 'primary',
            admissionCondition: '1',
            ordinal: 1,
            coding: {
              id: diagnosisRevision === 1 ? 'diagnosis-1' : 'diagnosis-2',
              system: 'urn:clinmesh:reference:nhsa-diagnosis',
              version: '2022',
              code: diagnosisRevision === 1 ? 'I20.000' : 'I21.401',
              display: diagnosisRevision === 1 ? '不稳定型心绞痛' : '急性非ST段抬高型心肌梗死',
              releaseId: 'clinmesh-icd10-2026',
              sourceLocator: 'cn-health:diagnosis:1',
            },
          }],
        },
        orders: [],
        executions: [],
        dispenses: [],
        charges: [],
        chargesFen: 0,
      }))
    }
    if (path.endsWith('/surgeries')) return Response.json({
      admissionId: admission.id,
      encounterVersion: '1',
      virtualTime: time,
      requests: [{ ...plan, version: requestVersion, status: 'requested', consentConfirmation: undefined }],
      executions: [],
      inProgress: [],
    })
    if (path.endsWith('/surgery-catalog')) return Response.json({
      procedures: [procedure],
      materials: [material],
      locations: emptyLocations ? [] : [{ id: 'location-catheterization-lab', name: '导管室', nameEn: 'Catheterization Lab' }],
      practitioners: [],
    })
    if (path.endsWith('/drg/reservations')) return Response.json({ admissionId: admission.id, encounterVersion: '1', reservationSets: [], reservations: [] })
    if (path.endsWith('/material-estimates')) return Response.json({ admissionId: admission.id, estimates: [], unprepared: [] })
    return Response.json({ error: { code: 'UNAVAILABLE', message: '合成次级资料未准备' } }, { status: 503 })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  function Harness() {
    const write = useInpatientWriteIntent(currentSession, () => client.invalidateQueries({ queryKey: ['inpatient'] }))
    return <InpatientActionProvider stage="surgery"><InpatientSurgery admission={admission} session={currentSession} locale="zh-CN" write={write} /><InpatientActionOutlet /></InpatientActionProvider>
  }
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>)
  const user = userEvent.setup()

  await user.click(await screen.findByRole('button', { name: '申请手术' }))
  const reqDialog = await screen.findByRole('dialog', { name: '申请手术' })
  await waitFor(() => expect(within(reqDialog).getByText('当前无可用手术执行地点，暂不可提交手术申请')).toBeDefined())
  expect(within(reqDialog).queryByText('导管室')).toBeNull()
  expect(within(reqDialog).getByRole('button', { name: '提交手术申请' }).hasAttribute('disabled')).toBe(true)

  emptyLocations = false
  await client.invalidateQueries({ queryKey: ['inpatient'] })
  await waitFor(() => expect(within(reqDialog).getByText('当前无可选手术医师，暂不可提交手术申请')).toBeDefined())
  expect(within(reqDialog).queryByText('住院医生')).toBeNull()
  expect(within(reqDialog).getByRole('button', { name: '提交手术申请' }).hasAttribute('disabled')).toBe(true)
  await user.click(within(reqDialog).getByRole('button', { name: '取消' }))

  await user.click(await screen.findByRole('button', { name: '确认已签' }))
  const consentDialog = await screen.findByRole('dialog', { name: '手术知情同意书' })
  const article = await within(consentDialog).findByRole('article', { name: '冠状动脉造影术知情同意书' })
  expect(article.textContent).toContain('I20.000 不稳定型心绞痛')

  diagnosisRevision = 2
  requestVersion = 4
  await user.click(within(consentDialog).getByRole('button', { name: '确认手术知情同意书已签' }))
  await waitFor(() => expect(confirmCalls).toHaveLength(1))
  expect(confirmCalls[0]).toMatchObject({ expectedDiagnosisRevision: 1, expectedRequestVersion: 3 })
  expect((await within(consentDialog).findByRole('alert')).textContent).toContain('手术申请或准备状态已变化')
  await waitFor(() => expect(within(consentDialog).getByRole('article', { name: '冠状动脉造影术知情同意书' }).textContent).toContain('I21.401 急性非ST段抬高型心肌梗死'))

  await user.click(within(consentDialog).getByRole('button', { name: '确认手术知情同意书已签' }))
  await waitFor(() => expect(confirmCalls).toHaveLength(2))
  expect(confirmCalls[1]).toMatchObject({ expectedDiagnosisRevision: 2, expectedRequestVersion: 4 })
})
