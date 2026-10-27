import { expect, test, loginPciBrowser } from './inpatient-pci.fixture.ts'
import { runPciBrowserJourney } from './inpatient-pci.journey.ts'
import { preparePciThroughPages, type OpenPciPatient } from './inpatient-pci-preparation.journey.ts'

test('从零页面完成 PCI 九检六次药品执行、未知收款恢复、归档核定与原交易退款', async ({ page, pciApp: app }) => {
  test.setTimeout(180_000)
  const errors: string[] = []
  const writes: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (['POST', 'PUT'].includes(request.method())) writes.push(new URL(request.url()).pathname)
  })
  const open: OpenPciPatient = async (role, name) => {
    await loginPciBrowser(page, app, role)
    await page.goto(`${app.origin}/${role === 'cashier' ? 'billing' : role === 'pharmacist' ? 'pharmacy' : 'inpatient'}`)
    if (role === 'cashier') await page.getByRole('tab', { name: '住院费用', exact: true }).click()
    if (role === 'pharmacist') await page.getByRole('tab', { name: '住院药房', exact: true }).click()
    await page.getByRole('button', { name: `查看${name}`, exact: true }).click()
  }
  const stay = await preparePciThroughPages(page, app, open)
  await runPciBrowserJourney(page, app, open, stay)
  const indices = (suffix: string) => writes.flatMap((path, index) => path.endsWith(suffix) ? [index] : [])
  expect(indices('/investigations/issue')).toHaveLength(9)
  expect(indices('/investigations/acknowledge')).toHaveLength(9)
  expect(indices('/executions/dispense')).toHaveLength(6)
  expect(indices('/executions/administer')).toHaveLength(6)
  expect(indices('/surgeries/execute')).toHaveLength(2)
  expect(indices('/investigations/acknowledge').at(-1)!).toBeLessThan(indices('/surgeries/execute')[0]!)
  expect(indices('/surgeries/execute').at(-1)!).toBeLessThan(indices('/orders/issue').at(-1)!)
  expect(indices('/orders/issue').at(-1)!).toBeLessThan(indices('/executions/dispense').at(-1)!)
  expect(indices('/executions/dispense').at(-1)!).toBeLessThan(indices('/executions/administer').at(-1)!)
  expect(app.modelCalls).toBe(0)
  expect(errors).toEqual([])
})
