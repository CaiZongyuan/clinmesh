import { doctorCaseDetailSchema } from '@clinmesh/contracts/his'
import { z } from 'zod'
import { sourceArtifactHash } from '../../server/src/application/scenario-data/provider.ts'
import { startBrowserServer } from '../../server/tests/browser-server.ts'
import { persona, startConsultationCase, StubSyntheaProvider } from '../../server/tests/fixtures/consultation.ts'
import { expect, test } from './fixtures.ts'

test('restores independent histories across cases, records family history automatically and protects unsaved allergy text', async ({ page, webRoot }) => {
  const reply = '我父亲患高血压。对青霉素过敏。'
  const server = await startBrowserServer(webRoot, {
    dshModelBridge: { origin: 'http://127.0.0.1:1', secret: 'synthetic-bridge-secret-at-least-32-characters', timeoutMs: 2000, maxResponseBytes: 8192 },
    syntheaProvider: new class extends StubSyntheaProvider {
      generated = 0
      override async generate() {
        const corpus = await super.generate()
        const sources = corpus.sources.map(source => {
          const raw = z.object({ entry: z.array(z.object({ resource: z.record(z.string(), z.unknown()) }).passthrough()) }).passthrough().parse(source.raw)
          raw.entry.find(entry => entry.resource.resourceType === 'Patient')!.resource.name = [{ text: `合成患者${++this.generated}` }]
          return { ...source, raw, hash: sourceArtifactHash(raw) }
        })
        return { ...corpus, sources }
      }
    }(),
    chatCompletionsProvider: { async completeJson(input) {
      if (input.schemaName === 'patient_persona') return { content: JSON.stringify(persona), model: 'synthetic' }
      if (input.schemaName === 'patient_dialogue_reply') return { content: JSON.stringify({ reply }), model: 'synthetic' }
      const payload = input.userPayload as { turns: Array<{ id: string }> }
      const sourceTurnId = payload.turns.at(-1)!.id
      return { content: JSON.stringify({ additions: [
        { field: 'familyHistory', sourceTurnId, quote: '我父亲患高血压。', relation: 'addition' },
        { field: 'allergyHistory', sourceTurnId, quote: '对青霉素过敏。', relation: 'addition' },
      ] }), model: 'synthetic' }
    } },
  })
  try {
    const first = await startConsultationCase(server.runtime, server.password, server.origin)
    const second = await startConsultationCase(server.runtime, server.password, server.origin)
    expect(second.outpatientCaseId).not.toBe(first.outpatientCaseId)
    const read = async () => doctorCaseDetailSchema.parse(await (await page.request.get(
      `${server.origin}/api/his/v1/doctor/cases/${first.outpatientCaseId}`)).json())
    const select = (caseId: string) => page.locator(`[data-agent-selection="${caseId}"]`).click()
    const family = page.getByLabel('家族史', { exact: true })
    const allergy = page.getByLabel('过敏史', { exact: true })
    const save = page.getByRole('button', { name: '保存病历草稿', exact: true })
    const unsaved = page.getByText('有未保存修改，请保存草稿。', { exact: true })
    const saved = page.getByText('病历草稿已保存', { exact: true })
    await page.goto(`${server.origin}/consultation`)
    await page.getByLabel('账户邮箱').fill('doctor@demo.clinmesh.local')
    await page.getByLabel('账户密码').fill(server.password)
    await page.getByRole('button', { name: '登录', exact: true }).click()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await select(first.outpatientCaseId)
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(unsaved).toHaveCount(0)
    await family.fill('家族情况待问诊。')
    await allergy.fill('医生记录：药物待核实。')
    await expect(unsaved).toBeVisible()
    await expect(page.locator('[data-clinical-document-update]')).toHaveCount(0)
    await page.route('**/clinical-document/draft', route => route.fulfill({ status: 503,
      json: { error: { code: 'SERVICE_UNAVAILABLE', message: 'Synthetic save failure' } },
    }), { times: 1 })
    const failedSave = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/clinical-document/draft') && response.status() === 503)
    await save.click()
    await failedSave
    await expect(save).toBeEnabled()
    await expect(unsaved).toBeVisible()
    await expect(family).toHaveValue('家族情况待问诊。')
    await save.click()
    await expect.poll(async () => (await read()).clinicalDocument?.draft?.familyHistory).toBe('家族情况待问诊。')
    await expect(unsaved).toHaveCount(0)
    await expect(saved).toBeVisible()
    await page.getByRole('tab', { name: '待诊', exact: true }).click()
    await select(second.outpatientCaseId)
    await page.getByRole('button', { name: '开始首诊', exact: true }).click()
    await expect(page.getByRole('tab', { name: '在诊', exact: true, includeHidden: true })).toHaveAttribute('aria-selected', 'true')
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(family).toHaveValue('')
    await expect(allergy).toHaveValue('')
    await expect(unsaved).toHaveCount(0)
    await page.getByRole('tab', { name: '在诊', exact: true }).click()
    await select(first.outpatientCaseId)
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(family).toHaveValue('家族情况待问诊。')
    await expect(allergy).toHaveValue('医生记录：药物待核实。')
    await family.fill('')
    await expect(unsaved).toBeVisible()
    await expect(saved).toHaveCount(0)
    await family.fill('家族情况待问诊。')
    await expect(unsaved).toHaveCount(0)
    await family.fill('')
    await expect(unsaved).toBeVisible()
    await save.click()
    await expect.poll(async () => (await read()).clinicalDocument?.draft?.familyHistory).toBe('')
    await expect(unsaved).toHaveCount(0)
    await page.reload()
    await select(first.outpatientCaseId)
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(family).toHaveValue('')
    await expect(unsaved).toHaveCount(0)
    await allergy.fill('医生未保存的过敏核对。')
    await expect(unsaved).toBeVisible()
    await select(second.outpatientCaseId)
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(unsaved).toHaveCount(0)
    await select(first.outpatientCaseId)
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(allergy).toHaveValue('医生未保存的过敏核对。')
    await expect(unsaved).toBeVisible()
    await page.getByRole('tab', { name: '问诊记录', exact: true }).click()
    await page.getByRole('textbox', { name: '向患者提问', exact: true }).fill('请补充家族史和过敏史。')
    await page.getByRole('button', { name: '向患者提问', exact: true }).click()
    await expect(page.getByText(reply, { exact: true })).toBeVisible()
    await server.runtime.dispatchPending()
    await page.getByRole('tab', { name: '病历记录', exact: true }).click()
    await expect(family).toHaveValue('患者自述：我父亲患高血压。')
    const workingAllergy = '医生未保存的过敏核对。\n患者自述：对青霉素过敏。'
    await expect(allergy).toHaveValue(workingAllergy)
    const familyField = page.locator('[data-clinical-document-field="familyHistory"]')
    const allergyField = page.locator('[data-clinical-document-field="allergyHistory"]')
    await expect(familyField.getByRole('status')).toHaveText('已更新')
    await expect(allergyField.getByRole('status')).toHaveText('已更新')
    await family.fill('医生补充的家族史。')
    await expect(familyField.getByRole('status')).toHaveCount(0)
    await expect(allergyField.getByRole('status')).toHaveText('已更新')
    await expect(page.getByRole('button', { name: '应用建议', exact: true })).toHaveCount(0)
    expect((await read()).clinicalDocument?.draft?.allergyHistory).toBe('医生记录：药物待核实。\n患者自述：对青霉素过敏。')
    await expect(page.getByRole('button', { name: '查看来源', exact: true })).toHaveCount(0)
    expect((await read()).clinicalDocument?.draft?.priorMedicalHistory).not.toContain('青霉素')
  } finally { await server.close() }
})
