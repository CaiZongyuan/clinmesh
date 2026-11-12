import { openWorkspaceTab } from './workspace-tabs.fixture.ts'
import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'
import { waitForRecordedHistory } from './consultation-recording.ts'

test('confirms specialty visit classification, recovers signing preparation and signs with contextual histories', async ({ page, webRoot }) => {
  let reply = '头晕一周了。'
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new StubSyntheaProvider(), autoDispatchIntervalMs: 50,
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply }), model: 'synthetic' }
      const payload = input.userPayload as { turns: Array<{ id: string; messageText: string }> }
      const turn = payload.turns.at(-1)!
      return { content: JSON.stringify({ additions: [{ field: 'historyOfPresentIllness', sourceTurnId: turn.id,
        quote: turn.messageText, relation: 'addition' }] }), model: 'synthetic' }
    } },
  })
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  try {
    const started = await startConsultationCase(server.runtime, server.password, server.origin)
    server.runtime.database.driver.prepare(`UPDATE outpatient_catalog SET code = 'GYN' WHERE kind = 'department'
      AND item_id = (SELECT department_id FROM outpatient_case WHERE case_id = ?)`)
      .run(started.outpatientCaseId)
    const read = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${started.outpatientCaseId}`)).json())
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await page.getByText('张琴', { exact: true }).first().click()
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    const ask = async () => {
      await openWorkspaceTab(page, '问诊记录')
      await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('请补充病史？')
      await page.getByRole('button', { name: '向患者提问', exact: true }).click()
      await expect(page.getByText(reply, { exact: true })).toBeVisible()
      await openWorkspaceTab(page, '病历记录')
    }
    await openWorkspaceTab(page, '病历记录')
    await expect(page.getByLabel('家族史', { exact: true })).toHaveValue('')
    await expect(page.getByLabel('过敏史', { exact: true })).toHaveValue('')
    expect((await read()).clinicalHistory).toMatchObject({ visitKind: 'unknown', requiredFields: [] })
    await expect(page.locator('[data-clinical-document-field="chiefComplaint"] [data-required-indicator]')).toHaveText('*')
    await expect(page.locator('[data-clinical-document-field="familyHistory"] [data-required-indicator]')).toHaveCount(0)
    for (const field of ['月经史', '孕产史']) {
      const input = page.getByLabel(field, { exact: true })
      await expect(input).not.toHaveAttribute('required', '')
      await expect(page.locator('[data-clinical-document-field]').filter({ has: input }).locator('[data-required-indicator]')).toHaveCount(0)
    }
    const confirmClassification = async (kind: '初诊' | '随访／复诊') => {
      await page.getByRole('button', { name: '核实文书类型', exact: true }).click()
      const classification = page.getByRole('dialog', { name: '核实文书类型', exact: true })
      await classification.getByRole('button', { name: kind, exact: true }).click()
      await classification.getByLabel('核实依据', { exact: true }).fill(`医生已核实本次为${kind}。`)
      await classification.getByRole('button', { name: '核实文书类型', exact: true }).click()
      await expect(classification).toHaveCount(0)
    }
    await confirmClassification('随访／复诊')
    expect((await read()).clinicalHistory).toMatchObject({ visitKind: 'follow-up', requiredFields: [] })
    await confirmClassification('初诊')
    expect((await read()).clinicalHistory).toMatchObject({ visitKind: 'initial', requiredFields: ['menstrualHistory', 'obstetricHistory'] })
    for (const label of ['月经史', '孕产史']) {
      const field = page.getByLabel(label, { exact: true })
      await expect(field).toHaveValue('')
      await expect(field).toHaveAttribute('required', '')
      await expect(page.locator('[data-clinical-document-field]').filter({ has: field }).locator('[data-required-indicator]')).toHaveText('*')
    }
    await page.getByLabel('家族史', { exact: true }).fill('父亲患高血压，患者自述。')
    await page.getByLabel('过敏史', { exact: true }).fill('青霉素用药后皮疹，患者自述。')
    await page.getByLabel('现病史', { exact: true }).fill('')
    await page.getByRole('button', { name: '保存病历草稿', exact: true }).click()
    await expect.poll(async () => (await read()).clinicalDocument?.draft?.familyHistory).toBe('父亲患高血压，患者自述。')
    await page.reload()
    await openWorkspaceTab(page, '病历记录')
    await expect(page.getByLabel('家族史', { exact: true })).toHaveValue('父亲患高血压，患者自述。')
    await expect(page.getByLabel('过敏史', { exact: true })).toHaveValue('青霉素用药后皮疹，患者自述。')
    await ask()
    await waitForRecordedHistory(page, reply)
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue('患者自述：头晕一周了。')
    await page.getByRole('button', { name: '暂停自动整理', exact: true }).click()
    await expect(page.getByRole('button', { name: '恢复并补录', exact: true })).toBeEnabled()
    reply = '站起来时更明显。'
    await ask()
    for (const [label, text] of [
      ['主诉', '头晕一周。'], ['既往史', '既往高血压。'], ['体格检查', '查体未见明显异常。'],
      ['辅助检查', '暂无检查。'], ['评估', '继续评估。'], ['处置', '门诊随访。'], ['随访', '加重时及时就诊。'],
    ]) await page.getByLabel(label!, { exact: true }).fill(text!)
    await page.getByRole('button', { name: '签署病历', exact: true }).click()
    await expect(page.getByRole('alertdialog', { name: '确认签署病历', exact: true })).toHaveCount(0)
    expect(await page.getByLabel('月经史', { exact: true }).evaluate(element => (element as HTMLTextAreaElement).validity.valueMissing)).toBe(true)
    await page.getByLabel('月经史', { exact: true }).fill('患者自述已绝经。')
    await page.getByLabel('孕产史', { exact: true }).fill('患者自述孕2产2。')
    await page.getByRole('button', { name: '签署病历', exact: true }).click()
    const dialog = page.getByRole('alertdialog', { name: '确认签署病历', exact: true })
    await expect(dialog).toContainText('患者自述已绝经。')
    await expect(dialog).toContainText('患者自述孕2产2。')
    await expect(dialog).toContainText('父亲患高血压，患者自述。')
    await expect(dialog).toContainText('青霉素用药后皮疹，患者自述。')
    const commit = dialog.getByRole('button', { name: '确认签署病历', exact: true })
    await expect(commit).toBeEnabled()
    const firstPreviewId = (await read()).consultationRecording!.signingPreparation!.previewId
    await page.route('**/clinical-document/actions/cancel-sign', async route => {
      const response = await route.fetch()
      expect(response.ok()).toBe(true)
      await route.abort('failed')
    }, { times: 1 })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await read()).consultationRecording!.signingPreparation).toBeUndefined()
    expect((await read()).consultationRecording).toMatchObject({ paused: true, remainingCount: 1 })
    await page.getByRole('button', { name: '签署病历', exact: true }).click()
    await expect(dialog).toBeVisible()
    expect((await read()).consultationRecording!.signingPreparation!.previewId).not.toBe(firstPreviewId)
    await page.reload()
    await openWorkspaceTab(page, '问诊记录')
    await expect(page.getByRole('button', { name: '恢复并补录', exact: true })).toBeDisabled()
    await openWorkspaceTab(page, '病历记录')
    await expect(page.getByText('签署准备尚未结束', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '返回编辑并恢复整理', exact: true }).click()
    await expect(page.getByText('签署准备尚未结束', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: '恢复并补录', exact: true }).click()
    await expect(page.getByLabel('现病史', { exact: true })).toHaveValue('患者自述：头晕一周了。\n患者自述：' + reply)
    await page.getByRole('button', { name: '签署病历', exact: true }).click()
    await expect(dialog.getByRole('checkbox')).toHaveCount(0)
    await expect(commit).toBeEnabled()
    await commit.click()
    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await read()).clinicalDocument!.signed.length).toBe(1)
    expect((await read()).clinicalDocument!.signed[0]!.content.historyOfPresentIllness).toBe('患者自述：头晕一周了。\n患者自述：' + reply)
    expect((await read()).clinicalDocument!.signed[0]!.content).toMatchObject({
      menstrualHistory: '患者自述已绝经。', obstetricHistory: '患者自述孕2产2。',
      familyHistory: '父亲患高血压，患者自述。', allergyHistory: '青霉素用药后皮疹，患者自述。',
    })
    await page.getByRole('button', { name: '修改病历', exact: true }).click()
    const revision = page.getByRole('form', { name: '修订病历版本', exact: true })
    const history = page.getByRole('region', { name: '签署历史', exact: true })
    await expect(history.locator('details[open]')).toHaveCount(0)
    await history.locator('summary').filter({ hasText: '第 1 次签署' }).click()
    await expect(history.locator('[data-clinical-document-field="familyHistory"]')).toContainText('父亲患高血压，患者自述。')
    await expect(revision.getByLabel('家族史', { exact: true })).toHaveValue('父亲患高血压，患者自述。')
    await expect(revision.getByLabel('过敏史', { exact: true })).toHaveValue('青霉素用药后皮疹，患者自述。')
    await expect(revision.getByLabel('月经史', { exact: true })).toHaveValue('患者自述已绝经。')
    await expect(revision.getByLabel('孕产史', { exact: true })).toHaveValue('患者自述孕2产2。')
    await revision.getByLabel('月经史', { exact: true }).fill('')
    await revision.getByLabel('修订原因', { exact: true }).fill('核对病史。')
    await revision.getByRole('button', { name: '提交病历修订', exact: true }).click()
    await expect(page.getByRole('alertdialog', { name: '确认提交病历修订', exact: true })).toHaveCount(0)
    await revision.getByLabel('月经史', { exact: true }).fill('患者自述已绝经。')
    await revision.getByLabel('家族史', { exact: true }).fill('')
    await revision.getByLabel('过敏史', { exact: true }).fill('过敏药物待进一步核实。')
    await revision.getByLabel('修订原因', { exact: true }).fill('重新核对家族及过敏自述。')
    await history.locator('summary').filter({ hasText: '第 1 次签署' }).click()
    await expect(revision.getByLabel('家族史', { exact: true })).toHaveValue('')
    await expect(revision.getByLabel('过敏史', { exact: true })).toHaveValue('过敏药物待进一步核实。')
    await revision.getByRole('button', { name: '提交病历修订', exact: true }).click()
    const revisionDialog = page.getByRole('alertdialog', { name: '确认提交病历修订', exact: true })
    await expect(revisionDialog.locator('[data-clinical-document-field="familyHistory"]')).toContainText('未记录')
    await expect(revisionDialog).toContainText('过敏药物待进一步核实。')
    await revisionDialog.getByRole('button', { name: '确认提交修订', exact: true }).click()
    await expect(revisionDialog).toHaveCount(0)
    await expect.poll(async () => (await read()).clinicalDocument!.signed.length).toBe(2)
    expect((await read()).clinicalDocument!.signed.map(document => ({ familyHistory: document.content.familyHistory, allergyHistory: document.content.allergyHistory })))
      .toEqual([
        { familyHistory: '父亲患高血压，患者自述。', allergyHistory: '青霉素用药后皮疹，患者自述。' },
        { familyHistory: '', allergyHistory: '过敏药物待进一步核实。' },
      ])
    await expect(history.locator('summary').nth(0)).toContainText('第 2 次签署')
    await expect(history.locator('summary').nth(0)).toContainText('当前生效')
    await expect(history.locator('summary').nth(0)).toContainText('重新核对家族及过敏自述。')
    await expect(history.locator('details[open]')).toHaveCount(0)
    await revision.getByLabel('家族史', { exact: true }).fill('第三版补充家族史。')
    await revision.getByLabel('修订原因', { exact: true }).fill('补充再次核对的家族史。')
    await revision.getByRole('button', { name: '提交病历修订', exact: true }).click()
    await revisionDialog.getByRole('button', { name: '确认提交修订', exact: true }).click()
    await expect.poll(async () => (await read()).clinicalDocument!.signed.length).toBe(3)
    await page.reload()
    await openWorkspaceTab(page, '病历记录')
    const summaries = history.locator('summary')
    await expect(summaries).toHaveCount(3)
    for (const [index, version] of [3, 2, 1].entries()) await expect(summaries.nth(index)).toContainText(`第 ${version} 次签署`)
    await expect(history.locator('details[open]')).toHaveCount(0)
    await page.getByRole('button', { name: '修改病历', exact: true }).click()
    await expect(revision.getByLabel('家族史', { exact: true })).toHaveValue('第三版补充家族史。')
    await revision.getByLabel('家族史', { exact: true }).fill('尚未提交的第四版家族史。')
    await revision.getByLabel('修订原因', { exact: true }).fill('尚未提交的修订原因。')
    for (const summary of await summaries.all()) await summary.click()
    await expect(history.locator('details[open]')).toHaveCount(3)
    const versions = history.locator('details')
    await expect(versions.nth(0).locator('[data-clinical-document-field="familyHistory"]')).toContainText('第三版补充家族史。')
    await expect(versions.nth(1).locator('[data-clinical-document-field="familyHistory"]')).toContainText('未记录')
    await expect(versions.nth(2).locator('[data-clinical-document-field="familyHistory"]')).toContainText('父亲患高血压，患者自述。')
    await expect(versions.nth(2).locator('[data-clinical-document-field="allergyHistory"]')).toContainText('青霉素用药后皮疹，患者自述。')
    await expect(revision.getByLabel('家族史', { exact: true })).toHaveValue('尚未提交的第四版家族史。')
    await expect(revision.getByLabel('修订原因', { exact: true })).toHaveValue('尚未提交的修订原因。')
    await page.setViewportSize({ width: 900, height: 800 })
    expect(await history.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    expect(await revision.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
    const revisionBounds = await revision.boundingBox()
    const historyBounds = await history.boundingBox()
    expect(revisionBounds!.y + revisionBounds!.height).toBeLessThan(historyBounds!.y)
    await openWorkspaceTab(page, '问诊记录')
    await expect(page.getByRole('button', { name: '暂停自动整理', exact: true })).toHaveCount(1)
    await expect(page.getByRole('button', { name: '暂停自动整理', exact: true })).toBeDisabled()
    expect(errors).toEqual([])
  } finally { await server.close() }
})
