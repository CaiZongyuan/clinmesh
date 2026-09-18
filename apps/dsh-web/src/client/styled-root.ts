import { clinMeshStyles } from './styles.generated.ts'

/** 宿主树内渲染 clinmesh 组件的样式容器:shadow root 隔离 + 注入 clinmesh 样式。 */
export function createStyledRoot(host: HTMLElement): { root: HTMLDivElement; dispose(): void } {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = clinMeshStyles
  const root = document.createElement('div')
  root.className = 'clinmesh-web-root'
  root.style.cssText = 'min-height:0;min-width:0;background:transparent;'
  shadow.append(style, root)
  return { root, dispose: () => { root.remove(); style.remove() } }
}
