import type { Locator } from '@playwright/test'

/** 布局采样等待有限动画结束；持续状态动画不属于布局稳定条件。 */
export async function waitForLayout(locator: Locator) {
  await locator.evaluate(async element => {
    for (;;) {
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      const animations = element.getAnimations({ subtree: true })
        .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity
          && animation.playState !== 'finished' && animation.playState !== 'idle')
      if (animations.length === 0) return
      // CSS 更新可以正常取消旧动画并生成新动画；下一轮重新读取，不采样中间态。
      await Promise.allSettled(animations.map(animation => animation.finished))
    }
  })
}
