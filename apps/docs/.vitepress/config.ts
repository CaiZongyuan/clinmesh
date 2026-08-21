import { resolve } from 'node:path'
import type { ViteDevServer } from 'vite'
import type { DefaultTheme } from 'vitepress'
import { defineConfig } from 'vitepress'
import { orderedPages, routeLink, type DocsSidebar } from '../docs.ts'
import { docsSourceFiles, projectDocs } from '../../../scripts/project-doc-site.ts'

projectDocs()

function sidebar(collection: DocsSidebar): DefaultTheme.SidebarItem[] {
  const groups = new Map<string, DefaultTheme.SidebarItem[]>()
  for (const page of orderedPages(collection)) {
    const items = groups.get(page.section) ?? []
    items.push({ text: page.label, link: routeLink(page.route) })
    groups.set(page.section, items)
  }
  return [...groups.entries()].map(([text, items]) => ({ text, items }))
}

function watchCanonicalDocs(server: ViteDevServer): void {
  const sources = docsSourceFiles()
  server.watcher.add(sources)
  server.watcher.on('change', (changed) => {
    if (sources.includes(changed)) projectDocs()
  })
}

const base = process.env.DOCS_BASE ?? '/'

export default defineConfig({
  title: 'ClinMesh',
  description: 'Agent + 中国公立医院仿真 HIS',
  lang: 'zh-CN',
  base,
  cleanUrls: true,
  srcDir: '.generated',
  cacheDir: '.cache',
  outDir: '.dist',
  themeConfig: {
    nav: [
      { text: '架构', link: '/architecture/system' },
      { text: '工程', link: '/engineering/agent-development' },
    ],
    sidebar: {
      '/architecture/': sidebar('architecture'),
      '/engineering/': sidebar('engineering'),
    },
    search: { provider: 'local' },
    outline: { label: '本页目录', level: [2, 3] },
    docFooter: { prev: '上一篇', next: '下一篇' },
    returnToTopLabel: '返回顶部',
    sidebarMenuLabel: '菜单',
  },
  vite: {
    plugins: [{ name: 'clinmesh-doc-projector', configureServer: watchCanonicalDocs }],
    publicDir: resolve(import.meta.dirname, '../public'),
  },
  head: [['meta', { name: 'theme-color', content: '#ffffff' }]],
})
