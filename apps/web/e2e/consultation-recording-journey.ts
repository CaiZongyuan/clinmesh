import { expect, type Page } from '@playwright/test'
import type { DoctorCaseDetail } from '@clinmesh/contracts/his'

export const journeyReplies = {
  initial: '头晕一周了。站起来时更明显。',
  addition: '夜间也会头晕。',
  correction: '刚才说错了，头晕是六天。',
  paused: '躺着休息能缓过来。',
  failure: '坐着也会头晕。',
  late: '昨天晚上也头晕了。',
} as const

export type JourneyStage = keyof typeof journeyReplies

// The same visible journey runs against production Web in CI and the native host.
export async function runRecordingJourney(input: {
  page: Page
  read: () => Promise<DoctorCaseDetail>
  stage: (stage: JourneyStage, fail?: boolean) => Promise<void>
  waitForExtraction: () => Promise<void>
  releaseExtraction: () => Promise<void>
  settleExtraction: () => Promise<void>
  reload?: () => Promise<void>
  agentDraft?: () => Promise<void>
  agentSign?: () => Promise<void>
  progress?: (stage: string) => void
}) {
  const { page, read } = input
  const history = page.getByLabel('现病史', { exact: true })
  const recording = page.getByRole('tabpanel', { name: '病历记录', exact: true }).locator('[data-consultation-recording]')
  const ask = async (stage: JourneyStage, fail = false) => {
    await input.stage(stage, fail)
    const previous = (await read()).consultation!.turns.length
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('请补充这次头晕的情况？')
    await page.getByRole('button', { name: '向患者提问', exact: true }).click()
    await expect.poll(async () => (await read()).consultation!.turns.length).toBe(previous + 2)
    await expect(page.getByText(journeyReplies[stage], { exact: true })).toBeVisible()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
  }
  const reload = async () => {
    if (input.reload) await input.reload()
    else await page.reload()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
  }
  const row = (quote: string, status = 'applied') => page.locator(`[data-consultation-addition="${status}"]`).filter({ hasText: quote })
  const source = page.getByRole('dialog', { name: '患者原回答', exact: true })
  const dialog = page.getByRole('alertdialog', { name: '确认签署病历', exact: true })

  await ask('initial')
  await expect(history).toHaveValue('患者自述：头晕一周了。\n患者自述：站起来时更明显。')
  await reload()
  await expect(page.locator('[data-consultation-unreviewed]')).toHaveAttribute('data-consultation-unreviewed', '2')
  await row('站起来时更明显。').getByRole('button', { name: '查看来源', exact: true }).click()
  await expect(source.locator('blockquote')).toHaveText(journeyReplies.initial)
  await page.keyboard.press('Escape')
  await expect(source).toHaveCount(0)
  await history.fill('医生核对：头晕五天。\n患者自述：站起来时更明显。')
  await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
  await expect.poll(async () => (await read()).consultationRecording!.additions[0]!.ownership).toBe('manual')
  await page.getByLabel('评估', { exact: true }).fill('医生未保存的评估。')
  await ask('addition')
  await expect(history).toHaveValue('医生核对：头晕五天。\n患者自述：站起来时更明显。\n患者自述：夜间也会头晕。')
  await expect(page.getByLabel('评估', { exact: true })).toHaveValue('医生未保存的评估。')
  await row('站起来时更明显。').getByRole('button', { name: '撤销此条', exact: true }).click()
  await expect(history).toHaveValue('医生核对：头晕五天。\n患者自述：夜间也会头晕。')
  await expect(page.getByLabel('评估', { exact: true })).toHaveValue('医生未保存的评估。')
  await ask('correction')
  await expect(row(journeyReplies.correction, 'pending')).toContainText('医生核对：头晕五天。')
  await row(journeyReplies.correction, 'pending').getByRole('button', { name: '忽略建议', exact: true }).click()
  await expect(history).toHaveValue('医生核对：头晕五天。\n患者自述：夜间也会头晕。')
  input.progress?.('来源、刷新、局部撤销、未保存编辑与冲突核对通过')

  for (const [label, value] of [
    ['主诉', '头晕五天。'], ['查体', '查体尚待进一步核实。'], ['辅助检查', '本次暂无检查结果。'],
    ['处置', '继续问诊并评估。'], ['随访', '加重时及时就诊。'],
  ]) await page.getByLabel(label!, { exact: true }).fill(value!)
  await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
  await expect(page.getByText('病历草稿已保存', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '暂停自动整理', exact: true }).click()
  await expect(recording).toHaveAttribute('data-consultation-recording', 'paused')
  await ask('paused')
  expect((await read()).consultationRecording).toMatchObject({ paused: true, remainingCount: 1 })
  await page.getByRole('button', { name: '签署病历', exact: true }).click()
  await expect(dialog).toContainText('待整理 1')
  await expect(dialog.getByRole('button', { name: '确认签署病历', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: '返回核对并恢复整理', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await reload()
  await expect(recording).toHaveAttribute('data-consultation-recording', 'paused')
  await page.getByRole('button', { name: '恢复并补录', exact: true }).click()
  await expect(history).toHaveValue('医生核对：头晕五天。\n患者自述：夜间也会头晕。\n患者自述：躺着休息能缓过来。')
  await ask('failure', true)
  await expect(recording).toHaveAttribute('data-consultation-recording', 'failed')
  await reload()
  await expect(page.getByText('自动记录超时，患者回答已保存，请根据问诊原文补充病史。', { exact: true })).toBeVisible()
  await input.stage('failure', false)
  await page.getByRole('button', { name: '重试病史整理', exact: true }).click()
  await expect(history).toHaveValue('医生核对：头晕五天。\n患者自述：夜间也会头晕。\n患者自述：躺着休息能缓过来。\n患者自述：坐着也会头晕。')
  expect((await read()).consultationRecording).toMatchObject({ remainingCount: 0, failedCount: 0 })
  expect((await read()).consultationRecording!.additions.filter(addition => addition.quote === '站起来时更明显。' && addition.status === 'applied')).toHaveLength(0)
  input.progress?.('暂停遗漏、取消准备、刷新补录与失败重试通过')

  await input.agentDraft?.()
  await ask('late')
  await input.waitForExtraction()
  await page.getByRole('button', { name: '签署病历', exact: true }).click()
  await expect(dialog).toContainText('待整理 1')
  const frozen = (await read()).clinicalDocument!.draft
  await input.releaseExtraction()
  await input.settleExtraction()
  expect((await read()).clinicalDocument!.draft).toEqual(frozen)
  await expect(history).toHaveValue(frozen!.historyOfPresentIllness)
  await dialog.getByRole('button', { name: '返回核对并恢复整理', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(history).toHaveValue(frozen!.historyOfPresentIllness + '\n患者自述：昨天晚上也头晕了。')
  if (input.agentSign) await input.agentSign()
  else await page.getByRole('button', { name: '签署病历', exact: true }).click()
  await expect(dialog).toBeVisible()
  const commit = dialog.getByRole('button', { name: '确认签署病历', exact: true })
  await expect(commit).toBeDisabled()
  expect((await read()).clinicalDocument!.signed).toHaveLength(0)
  await dialog.getByRole('checkbox').check()
  await commit.click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await read()).clinicalDocument!.signed.length).toBe(1)
  const signed = (await read()).clinicalDocument!.signed
  await reload()
  expect((await read()).clinicalDocument!.signed).toEqual(signed)
  for (const addition of (await read()).consultationRecording!.additions) {
    const turn = (await read()).consultation!.turns.find(candidate => candidate.id === addition.sourceTurnId)
    expect(turn?.speaker).toBe('patient')
    expect(turn?.messageText).toContain(addition.quote)
  }
  input.progress?.('签署在途冻结、取消恢复、人工确认与不可变文书通过')
  return { processedCount: (await read()).consultationRecording!.processedCount, signedCount: signed.length }
}
