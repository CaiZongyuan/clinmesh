import { useLayoutEffect, useSyncExternalStore } from 'react'
import {
  useOptionalWebRuntime,
  type WebRuntimeValue,
  type WebSurfaceCaseContextState,
} from '../web-runtime.tsx'

const subscribeUnavailable = () => () => {}
const getUnavailable = () => false

export function useSurfaceCaseContextVisible(): boolean {
  const visibility = useOptionalWebRuntime()?.surfaceCaseContext?.visibility
  return useSyncExternalStore(visibility?.subscribe ?? subscribeUnavailable, visibility?.getSnapshot ?? getUnavailable, getUnavailable)
}

/** 宿主右栏是否承载病例上下文:surface 模式接通端口且右栏可见。全屏(full-frame)
 * 布局下宿主右列默认被标记 inert、被全屏表面遮盖,此时回退内嵌 rail;宿主声明
 * fullscreenKeepsDetails(全屏保留右栏)时例外——右栏标签全屏下仍可见可交互,
 * 继续由宿主承载,避免出现应用内第二根栏。 */
export function hostCaseContextRail(
  runtime: Pick<WebRuntimeValue, 'mode' | 'surfaceCaseContext' | 'surfaceDisplay'> | null | undefined,
): boolean {
  if (runtime?.mode !== 'surface' || runtime.surfaceCaseContext === undefined) return false
  const display = runtime.surfaceDisplay
  return display?.fullscreen !== true || display.fullscreenKeepsDetails === true
}

/** surface 模式下把病例上下文快照发布到宿主右列;standalone、未接通 port 或无 runtime 时不发布。
 * 用 useLayoutEffect 在绘制前注册:切病例时宿主右栏(患者身份 UI)不得先画出一帧旧患者数据。 */
export function useSurfaceCaseContextPort(state: WebSurfaceCaseContextState | undefined): void {
  const runtime = useOptionalWebRuntime()
  const mode = runtime?.mode
  const surfaceCaseContext = runtime?.surfaceCaseContext
  useLayoutEffect(() => {
    if (mode !== 'surface' || surfaceCaseContext === undefined || state === undefined) return
    return surfaceCaseContext.register(state)
  }, [mode, surfaceCaseContext, state])
}
