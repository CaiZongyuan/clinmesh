import { expect, test } from './inpatient-drg.fixture.ts'
import { runWorkspaceModePresentation } from './workspace-mode-presentation.journey.ts'

test('收费员和药师切换门诊住院时保留同一种下拉控件', async ({ page, browserApp }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await runWorkspaceModePresentation(page, browserApp)
  expect(errors).toEqual([])
})
