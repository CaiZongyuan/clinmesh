import { expect, test } from '@playwright/test'
import { waitForLayout } from '../../../web/e2e/layout-stability.ts'

test('ShadowRoot 中有限尺寸动画结束后才采样，持续旋转不阻塞布局验收', async ({ page }) => {
  await page.setContent('<div id="host"></div>')
  await page.locator('#host').evaluate(host => {
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<header style="height:80px">合成患者头部<span>状态</span></header>'
    shadow.querySelector('header')!.animate([{ height: '80px' }, { height: '140px' }], { duration: 200, fill: 'forwards' })
    shadow.querySelector('span')!.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 100, iterations: Infinity })
  })
  const header = page.locator('header')
  await waitForLayout(header)
  expect((await header.boundingBox())!.height).toBe(140)
})

test('等待中的有限动画被正常取消后，继续按最终布局采样', async ({ page }) => {
  await page.setContent('<div id="host"></div><button style="position:fixed;top:0;right:0">取消动画</button>')
  await page.locator('#host').evaluate(host => {
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<header style="height:80px">合成患者头部</header>'
    const animation = shadow.querySelector('header')!.animate([{ height: '80px' }, { height: '140px' }], { duration: 10_000 })
    const finished = animation.finished
    Object.defineProperty(animation, 'finished', { get() { host.setAttribute('data-waiting', 'true'); return finished } })
    document.querySelector('button')!.onclick = () => animation.cancel()
  })
  const header = page.locator('header')
  const waiting = waitForLayout(header).catch(error => error)
  await expect(page.locator('#host')).toHaveAttribute('data-waiting', 'true')
  await page.getByRole('button', { name: '取消动画' }).click()
  expect(await waiting).toBeUndefined()
  expect((await header.boundingBox())!.height).toBe(80)
})

test('取消后立即出现新的尺寸动画时，仍等待替代动画完成', async ({ page }) => {
  await page.setContent('<div id="host"></div><button style="position:fixed;top:0;right:0">改变尺寸</button>')
  await page.locator('#host').evaluate(host => {
    const shadow = host.attachShadow({ mode: 'open' })
    shadow.innerHTML = '<header style="height:80px">合成患者头部</header>'
    const header = shadow.querySelector('header')!
    const animation = header.animate([{ height: '80px' }, { height: '140px' }], { duration: 10_000 })
    const finished = animation.finished
    Object.defineProperty(animation, 'finished', { get() { host.setAttribute('data-waiting', 'true'); return finished } })
    document.querySelector('button')!.onclick = () => {
      animation.cancel()
      header.animate([{ height: '80px' }, { height: '160px' }], { duration: 200, fill: 'forwards' })
    }
  })
  const header = page.locator('header')
  const waiting = waitForLayout(header)
  await expect(page.locator('#host')).toHaveAttribute('data-waiting', 'true')
  await page.getByRole('button', { name: '改变尺寸' }).click()
  await waiting
  expect((await header.boundingBox())!.height).toBe(160)
})
