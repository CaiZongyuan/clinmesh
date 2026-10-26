import { useLayoutEffect, type RefObject } from 'react'

/** 住院壳挂载期间把纸张画板（data-palette）挂到应用根元素：Dialog/Sheet/Select 等弹层经
 * portal 渲染在页面子树外，仅靠壳层类属性覆盖不到；独立属性避免与主题偏好（data-theme）
 * 互相覆盖；卸载时移除，门诊回到方向四。 */
export function useInpatientPaperTheme(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const root = ref.current?.closest('[data-clinmesh-app="web"]')
    if (!(root instanceof HTMLElement)) return
    root.dataset.palette = 'paper'
    return () => { delete root.dataset.palette }
  }, [ref])
}
