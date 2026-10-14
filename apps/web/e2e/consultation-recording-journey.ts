import { expect, type Page } from '@playwright/test'
import type { DoctorCaseDetail } from '@clinmesh/contracts/his'
import { expandHistory } from './consultation-recording.ts'

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
  const dialog = page.getByRole('alertdialog', { name: '确认签署病历', exact: true })
  await page.getByRole('tab', { name: '病历记录', exact: true }).click()
  await history.fill('')
  await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
  await ask('initial')
  await expect(history).toHaveValue('患者自述：头晕一周了。\n患者自述：站起来时更明显。')
  await reload()
  await expandHistory(page)
  await page.locator('[data-consultation-addition="applied"]').filter({ hasText: '站起来时更明显。' }).getByRole('button', { name: '查看来源', exact: true }).click()
  const source = page.getByRole('dialog', { name: '患者原回答', exact: true })
  await expect(source.locator('blockquote')).toHaveText(journeyReplies.initial)
  await page.keyboard.press('Escape')
  await history.fill('医生核对：头晕五天。\n患者自述：站起来时更明显。')
  await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
  await expect.poll(async () => (await read()).consultationRecording!.additions[0]!.ownership).toBe('manual')
  await page.getByLabel('评估', { exact: true }).fill('医生未保存的评估。')
  await ask('addition')
  await expect(history).toHaveValue(/夜间也会头晕/)
  await expect(page.getByLabel('评估', { exact: true })).toHaveValue('医生未保存的评估。')
  await ask('correction')
  await expect(history).toHaveValue(/医生核对：头晕五天。[\s\S]*患者更正：[\s\S]*头晕是六天/)
  await expect(page.getByRole('button', { name: '应用建议', exact: true })).toHaveCount(0)
  input.progress?.('自动记录、来源、刷新、人工正文及未保存输入保护通过')
  for (const [label, value] of [
    ['主诉', '头晕五天。'], ['体格检查', '查体尚待进一步核实。'], ['辅助检查', '本次暂无检查结果。'],
    ['家族史', '父亲患高血压，患者自述。'], ['过敏史', '青霉素用药后皮疹，患者自述。'],
    ['处置', '继续问诊并评估。'], ['随访', '加重时及时就诊。'],
  ]) await page.getByLabel(label!, { exact: true }).fill(value!)
  await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
  await page.getByRole('button', { name: '暂停自动整理', exact: true }).click()
  await ask('paused')
  expect((await read()).consultationRecording).toMatchObject({ paused: true, remainingCount: 1 })
  await page.getByRole('button', { name: '签署病历', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '确认签署病历', exact: true })).toBeEnabled()
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await reload()
  await expect(recording).toHaveAttribute('data-consultation-recording', 'paused')
  await page.getByRole('button', { name: '恢复并补录', exact: true }).click()
  await expect(history).toHaveValue(/躺着休息能缓过来/)
  await ask('failure', true)
  await expect(recording).toHaveAttribute('data-consultation-recording', 'failed')
  await reload()
  await input.stage('failure', false)
  await page.getByRole('button', { name: '重试病史整理', exact: true }).click()
  await expect(history).toHaveValue(/坐着也会头晕/)
  expect((await read()).consultationRecording).toMatchObject({ remainingCount: 0, failedCount: 0 })
  input.progress?.('暂停、取消准备、刷新补录与失败重试通过')
  await input.agentDraft?.()
  await ask('late')
  await input.waitForExtraction()
  await page.getByRole('button', { name: '签署病历', exact: true }).click()
  const frozen = (await read()).clinicalDocument!.draft
  await input.releaseExtraction()
  await input.settleExtraction()
  expect((await read()).clinicalDocument!.draft).toEqual(frozen)
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(history).toHaveValue(/昨天晚上也头晕/)
  if (input.agentSign) await input.agentSign()
  else await page.getByRole('button', { name: '签署病历', exact: true }).click()
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('父亲患高血压，患者自述。')
  await expect(dialog).toContainText('青霉素用药后皮疹，患者自述。')
  await expect(dialog.getByRole('checkbox')).toHaveCount(0)
  await dialog.getByRole('button', { name: '确认签署病历', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect.poll(async () => (await read()).clinicalDocument!.signed.length).toBe(1)
  const signed = (await read()).clinicalDocument!.signed
  expect(signed[0]!.content).toMatchObject({ familyHistory: '父亲患高血压，患者自述。', allergyHistory: '青霉素用药后皮疹，患者自述。' })
  await reload()
  expect((await read()).clinicalDocument!.signed).toEqual(signed)
  input.progress?.('在途冻结、取消恢复、直接记录与不可变文书签署通过')
  return { processedCount: (await read()).consultationRecording!.processedCount, signedCount: signed.length }
}
