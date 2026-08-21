import { existsSync, globSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'

const root = resolve(import.meta.dirname, '..')
const files = globSync([
  '*.md',
  'docs/**/*.md',
  'apps/**/AGENTS.md',
  'packages/**/AGENTS.md',
  '.agents/notes/**/*.md',
  '.agents/skills/{code-simplifier,record-browser-gif}/**/*.md',
  '.agents/skills/dsh-*/**/*.md',
], {
  cwd: root,
  exclude: ['references/**', 'node_modules/**', '.agents/notes/archived/**'],
}).map(path => path.split(sep).join('/')).sort()
const errors: string[] = []

function isExternal(url: string): boolean {
  return url.startsWith('#') || url.startsWith('/') || url.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

function targetExists(sourcePath: string, rawUrl: string): boolean {
  const path = rawUrl.split(/[?#]/, 1)[0]
  if (path === undefined || path === '') return true
  let target = resolve(root, dirname(sourcePath), decodeURIComponent(path.replace(/:\d+$/, '')))
  if (existsSync(target)) return true
  if (extname(target) === '') {
    if (existsSync(`${target}.md`)) return true
    target = resolve(target, 'index.md')
    if (existsSync(target)) return true
  }
  return false
}

for (const file of files) {
  const content = readFileSync(resolve(root, file), 'utf8')
  if (!content.endsWith('\n')) errors.push(`${file}: file must end with one newline`)
  const fences = content.split('\n').filter(line => line.startsWith('```')).length
  if (fences % 2 !== 0) errors.push(`${file}: unbalanced fenced code blocks`)
  let tree: Nodes
  try {
    tree = fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  } catch (error: unknown) {
    errors.push(`${file}: Markdown parse failed: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }
  const visit = (node: Nodes): void => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && 'url' in node && !isExternal(node.url)) {
      if (!targetExists(file, node.url)) errors.push(`${file}: missing relative target ${JSON.stringify(node.url)}`)
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
}

for (const generated of ['apps/docs/.generated', 'apps/docs/.cache', 'apps/docs/.dist']) {
  const path = resolve(root, generated)
  if (existsSync(path) && !statSync(path).isDirectory()) errors.push(`${generated}: expected a generated directory`)
}

if (errors.length === 0) {
  console.log(`verify-docs: ${files.length} Markdown file(s) checked.`)
} else {
  console.error('verify-docs: violations found:')
  for (const error of errors) console.error(`  ${error}`)
  process.exitCode = 1
}
