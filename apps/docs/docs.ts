export type DocsSidebar = 'guide' | 'architecture' | 'engineering'

export interface DocsPage {
  source: string
  route: string
  label: string
  sidebar: DocsSidebar | null
  section: string
  order: number
  outline?: number | readonly [number, number] | 'deep' | false
  sourceAliases?: string[]
}

export const docsPages: DocsPage[] = [
  {
    source: 'docs/index.md',
    route: 'index.md',
    label: 'ClinMesh',
    sidebar: null,
    section: 'Home',
    order: 0,
  },
  {
    source: 'docs/deployment.md',
    route: 'guide/deployment.md',
    label: '部署指南',
    sidebar: 'guide',
    section: 'Guide',
    order: 1,
  },
  {
    source: 'docs/architecture.md',
    route: 'architecture/system.md',
    label: '系统架构',
    sidebar: 'architecture',
    section: 'Architecture',
    order: 1,
    outline: [2, 3],
  },
  {
    source: 'docs/frontend-architecture.md',
    route: 'architecture/frontend.md',
    label: '跨端前端架构',
    sidebar: 'architecture',
    section: 'Architecture',
    order: 2,
  },
  {
    source: 'docs/demo-architecture.md',
    route: 'architecture/demo.md',
    label: 'Demo 部署',
    sidebar: 'architecture',
    section: 'Architecture',
    order: 3,
  },
  {
    source: 'CONTEXT.md',
    route: 'architecture/domain-language.md',
    label: '领域词汇',
    sidebar: 'architecture',
    section: 'Reference',
    order: 1,
  },
  {
    source: 'docs/ui/design.md',
    route: 'architecture/clinical-ui.md',
    label: '临床 UI 设计合同',
    sidebar: 'architecture',
    section: 'Reference',
    order: 2,
    outline: [2, 3],
  },
  {
    source: 'docs/agent-development.md',
    route: 'engineering/agent-development.md',
    label: 'Agent 工程开发',
    sidebar: 'engineering',
    section: 'Engineering',
    order: 1,
  },
  {
    source: 'docs/testing.md',
    route: 'engineering/testing.md',
    label: '测试策略',
    sidebar: 'engineering',
    section: 'Engineering',
    order: 2,
  },
]

export function orderedPages(sidebar: DocsSidebar): DocsPage[] {
  return docsPages
    .filter(page => page.sidebar === sidebar)
    .sort((left, right) => left.section.localeCompare(right.section) || left.order - right.order)
}

export function routeLink(route: string): string {
  return `/${route.replace(/(?:index)?\.md$/, '')}`
}
