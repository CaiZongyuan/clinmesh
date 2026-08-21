import { platformLabel, type PlatformKind } from '@clinmesh/core/platform'

export interface AppShellProps {
  platform: Exclude<PlatformKind, 'mobile'>
}

const statusItems = [
  ['FHIR R5', '标准资源、SearchParameter 与 Operation 以 CapabilityStatement 的实际声明为准。'],
  ['Simulation', 'Workspace、epoch、虚拟时钟和合成数据构成可重复的 Agent 环境。'],
  ['Agent tools', '工具采用窄 schema、受信上下文、幂等和完整审计。'],
] as const

export function AppShell({ platform }: AppShellProps): React.JSX.Element {
  return (
    <div className="cm-shell">
      <header className="cm-header">
        <strong className="cm-brand">ClinMesh</strong>
        <span className="cm-platform">{platformLabel(platform)}</span>
      </header>
      <main className="cm-main">
        <h1 className="cm-heading">医院仿真工作台</h1>
        <p className="cm-lead">当前工程骨架已经连接跨端共享层。患者、就诊和 Agent 场景将在同一领域与协议模型上逐步实现。</p>
        <section className="cm-status-grid" aria-label="Architecture status">
          {statusItems.map(([title, copy]) => (
            <article className="cm-status-item" key={title}>
              <h2 className="cm-status-title">{title}</h2>
              <p className="cm-status-copy">{copy}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  )
}
