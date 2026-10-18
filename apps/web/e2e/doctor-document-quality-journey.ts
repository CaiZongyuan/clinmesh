import { expect, type Page } from '@playwright/test'
import {
  checkClinicalDocumentQualityRequestSchema,
  type ClinicalDocumentContent,
  type ClinicalDocumentQualityControlState,
  type DoctorCaseDetail,
} from '@clinmesh/contracts/his'
import { qualityPatientReply } from './doctor-document-quality-fixture.ts'

export async function runDocumentQualityJourney(input: {
  page: Page
  read: () => Promise<DoctorCaseDetail>
  quality: (clientId?: string) => Promise<ClinicalDocumentQualityControlState>
  agentDraft?: (document: ClinicalDocumentContent) => Promise<void>
  agentSign?: () => Promise<void>
  progress?: (message: string) => void
}) {
  const { page, read } = input
  let candidate: ReturnType<typeof checkClinicalDocumentQualityRequestSchema.parse>['input'] | undefined
  const observe = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname.endsWith('/document-quality-control/actions/check')) {
      candidate = checkClinicalDocumentQualityRequestSchema.parse(request.postDataJSON()).input
    }
  }
  page.on('request', observe)
  const current = async () => {
    const state = await input.quality(candidate?.clientId)
    return state.clientRevision === candidate?.clientRevision && state.status === 'ready' && !state.stale ? state : undefined
  }
  try {
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    const saved = (await read()).clinicalDocument?.draft
    const chiefComplaint = page.getByLabel('主诉', { exact: true })
    await chiefComplaint.fill('')
    await expect(page.getByRole('region', { name: '主诉质控提示', exact: true })).toContainText('待补充')
    await expect(chiefComplaint).toBeFocused()
    expect((await read()).clinicalDocument?.draft).toEqual(saved)

    const document: ClinicalDocumentContent = {
      chiefComplaint: '头晕。', historyOfPresentIllness: '头晕一周，站立时明显。', priorMedicalHistory: '既往高血压。',
      familyHistory: '父亲有高血压，患者自述。', allergyHistory: '药物过敏情况待核实。',
      physicalExamination: '今天上午体温36.5℃。', auxiliaryExamination: '本次暂无检查结果。',
      assessment: '头晕原因待查。', disposition: '继续核实病史。', followUp: '加重时及时就诊。',
    }
    for (const [field, label] of [
      ['chiefComplaint', '主诉'], ['historyOfPresentIllness', '现病史'], ['priorMedicalHistory', '既往史'],
      ['familyHistory', '家族史'], ['allergyHistory', '过敏史'],
      ['physicalExamination', '体格检查'], ['auxiliaryExamination', '辅助检查'], ['assessment', '评估'],
      ['disposition', '处置'], ['followUp', '随访'],
    ] as const) await page.getByLabel(label, { exact: true }).fill(document[field]!)

    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('请补充过敏史和今天上午的体温。')
    await page.getByRole('button', { name: '向患者提问', exact: true }).click()
    await expect(page.getByText(qualityPatientReply, { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect.poll(async () => (await current())?.issues.filter(issue => issue.status === 'open').map(issue => issue.kind).sort()).toEqual([
      'inconsistency', 'missing-field', 'omission',
    ])
    expect((await read()).clinicalDocument?.draft).toEqual(saved)
    await expect(page.getByRole('region', { name: '主诉质控提示', exact: true })).toContainText('持续时间')
    const prior = page.getByRole('region', { name: '过敏史质控提示', exact: true })
    await expect(prior).toContainText('待补充')
    await expect(prior.getByText('影响', { exact: true })).toBeVisible()
    await expect(prior.getByText('处理建议', { exact: true })).toBeVisible()
    await expect(prior).toContainText('过敏史正文未保留患者已陈述的青霉素过敏信息')
    await expect(prior).toContainText('核对患者原回答后补录过敏史，保留患者自述限定')
    await expect(prior.getByText(qualityPatientReply, { exact: true })).toHaveCount(0)
    expect((await current())?.issues.filter(issue => issue.field === 'auxiliaryExamination')).toEqual([])
    const evidence = prior.getByRole('button', { name: '查看依据', exact: true })
    await evidence.focus()
    await page.keyboard.press('Enter')
    await expect(prior).toContainText(qualityPatientReply)
    await expect(prior).toContainText('患者')
    await expect(evidence).toHaveCount(0)
    const verify = page.getByRole('region', { name: '体格检查质控提示', exact: true })
    await expect(verify).toContainText('待核实')
    await expect(verify).toContainText('对照原文核实两次测量的时间和来源')
    await verify.getByRole('button', { name: '查看依据', exact: true }).click()
    await expect(verify).toContainText('今天上午体温36.5℃。')
    await expect(verify).toContainText(qualityPatientReply)
    input.progress?.('未保存编辑、四类来源接线中的缺项/遗漏/矛盾与键盘依据展开通过')

    await prior.getByRole('button', { name: '已核实，保留', exact: true }).click()
    await prior.getByLabel('保留原因（选填）', { exact: true }).fill('已向患者复核，先保留当前书写。')
    await prior.getByRole('button', { name: '确认保留', exact: true }).click()
    await expect.poll(async () => (await input.quality(candidate?.clientId)).issues.find(issue => issue.kind === 'omission')?.review?.reason)
      .toBe('已向患者复核，先保留当前书写。')
    await page.getByLabel('评估', { exact: true }).fill('继续查明头晕原因。')
    await expect.poll(async () => (await current())?.issues.find(issue => issue.kind === 'omission')?.status).toBe('retained')
    await page.getByLabel('过敏史', { exact: true }).fill('药物过敏情况仍待核实。')
    await expect.poll(async () => (await current())?.issues.find(issue => issue.kind === 'omission')?.status).toBe('open')
    await page.getByLabel('过敏史', { exact: true }).fill('患者自述青霉素过敏。')
    await expect.poll(async () => (await current())?.issues.filter(issue => issue.kind === 'omission')).toEqual([])
    input.progress?.('核实原因持久化、无关编辑保留处理与相关内容变化重检通过')

    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect.poll(async () => (await read()).clinicalDocument?.draft?.allergyHistory)
      .toBe('患者自述青霉素过敏。')
    if (input.agentDraft !== undefined) {
      const { version: _version, updatedAt: _updatedAt, ...savedDocument } = (await read()).clinicalDocument!.draft!
      await input.agentDraft({ ...document, ...savedDocument })
      await expect.poll(async () => (await current())?.issues.some(issue => issue.kind === 'agent-source')).toBe(true)
      await expect(page.getByRole('region', { name: '评估质控提示', exact: true })).toContainText('待核实')
    }
    if (input.agentSign !== undefined) await input.agentSign()
    else await page.getByRole('button', { name: '签署病历', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: '确认签署病历', exact: true })
    const summary = dialog.getByRole('region', { name: '签署前质控汇总', exact: true })
    await expect(summary).toContainText('待核实')
    await expect(summary).toContainText('处理建议')
    const checkboxes = dialog.getByRole('checkbox')
    await expect(checkboxes).toHaveCount(0)
    const confirm = dialog.getByRole('button', { name: '确认签署病历', exact: true })
    await expect(confirm).toBeEnabled()
    await confirm.click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await read()).clinicalDocument?.signed.length).toBe(1)
    input.progress?.('未处理质控可见，人工签署沿用既有门禁且未新增勾选项')
    return { signedCount: 1, reviewedWithReason: true, agentSourceChecked: input.agentDraft !== undefined }
  } finally { page.off('request', observe) }
}
