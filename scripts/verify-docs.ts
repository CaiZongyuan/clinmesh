import { execFileSync } from 'node:child_process'
import { existsSync, globSync, lstatSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { collectMarkdownAnchors } from './project-doc-site.ts'

const defaultRoot = resolve(import.meta.dirname, '..')

function isExternalOrRootRelativeUrl(url: string): boolean {
  return url.startsWith('/') || url.startsWith('//') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

function splitUrl(rawUrl: string): { path: string; fragment: string | undefined } {
  const hashIndex = rawUrl.indexOf('#')
  const withoutHash = hashIndex === -1 ? rawUrl : rawUrl.slice(0, hashIndex)
  const fragment = hashIndex === -1 ? undefined : rawUrl.slice(hashIndex + 1)
  const queryIndex = withoutHash.indexOf('?')
  return {
    path: queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex),
    fragment,
  }
}

function resolveTarget(repoRoot: string, sourcePath: string, rawPath: string): string | undefined {
  if (rawPath === '') return resolve(repoRoot, sourcePath)
  const decoded = decodeURIComponent(rawPath)
  const direct = resolve(repoRoot, dirname(sourcePath), decoded)
  if (existsSync(direct) && !lstatSync(direct).isDirectory()) return direct

  const withoutLine = decoded.replace(/:\d+$/, '')
  const candidate = resolve(repoRoot, dirname(sourcePath), withoutLine)
  if (existsSync(candidate) && !lstatSync(candidate).isDirectory()) return candidate
  if (extname(candidate) === '') {
    if (existsSync(`${candidate}.md`)) return `${candidate}.md`
    const index = resolve(candidate, 'index.md')
    if (existsSync(index)) return index
  }
  return existsSync(candidate) ? candidate : undefined
}

export function verifyMarkdownFiles(repoRoot: string, relFiles: string[]): string[] {
  const errors: string[] = []
  const anchorCache = new Map<string, Set<string>>()

  const anchorsForFile = (absPath: string): Set<string> => {
    let cached = anchorCache.get(absPath)
    if (cached === undefined) {
      cached = collectMarkdownAnchors(readFileSync(absPath, 'utf8'))
      anchorCache.set(absPath, cached)
    }
    return cached
  }

  for (const file of relFiles) {
    const absFile = resolve(repoRoot, file)
    const content = readFileSync(absFile, 'utf8')
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
      if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && 'url' in node && !isExternalOrRootRelativeUrl(node.url)) {
        let parsed: { path: string; fragment: string | undefined }
        let target: string | undefined
        let decodedFragment: string | undefined
        try {
          parsed = splitUrl(node.url)
          target = resolveTarget(repoRoot, file, parsed.path)
          decodedFragment = parsed.fragment === undefined ? undefined : decodeURIComponent(parsed.fragment)
        } catch {
          errors.push(`${file}: malformed relative URL ${JSON.stringify(node.url)}`)
          return
        }
        if (target === undefined) {
          errors.push(`${file}: missing relative target ${JSON.stringify(node.url)}`)
        } else if (
          node.type !== 'image'
          && decodedFragment !== undefined
          && decodedFragment !== ''
          && !/^L\d+(?:-L?\d+)?$/.test(decodedFragment)
          && !lstatSync(target).isDirectory()
          && target.toLowerCase().endsWith('.md')
        ) {
          if (!anchorsForFile(target).has(decodedFragment)) {
            errors.push(`${file}: missing heading anchor ${JSON.stringify(node.url)}`)
          }
        }
      }
      if ('children' in node) for (const child of node.children) visit(child)
    }
    visit(tree)
  }

  return errors
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Git can check symlinks out as target-path placeholders on Windows; validate their canonical Markdown instead.
  const trackedSymlinks = new Set((existsSync(resolve(defaultRoot, '.git'))
    ? execFileSync('git', ['ls-files', '--stage', '-z', '--', '*.md'], { cwd: defaultRoot, encoding: 'utf8' }) : '')
    .split('\0').filter(entry => entry.startsWith('120000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1)))
  const files = globSync([
    '*.md',
    'docs/**/*.md',
    'apps/**/AGENTS.md',
    'packages/**/AGENTS.md',
    'skills/**/*.md',
    'deployment/**/*.md',
    'imaging-assets/**/*.md',
    'pathology-assets/**/*.md',
    '.github/**/*.md',
  ], {
    cwd: defaultRoot,
    exclude: [
      'references/**',
      'node_modules/**',
      '**/node_modules/**',
      'vendor/**',
      'apps/docs/.generated/**',
      'apps/docs/.cache/**',
      'apps/docs/.dist/**',
      'docs/decisions/archived/**',
    ],
  }).map(path => path.split(sep).join('/'))
    .filter(path => !trackedSymlinks.has(path) && !lstatSync(resolve(defaultRoot, path)).isSymbolicLink()).sort()

  const errors = verifyMarkdownFiles(defaultRoot, files)
  for (const generated of ['apps/docs/.generated', 'apps/docs/.cache', 'apps/docs/.dist']) {
    const path = resolve(defaultRoot, generated)
    if (existsSync(path) && !statSync(path).isDirectory()) errors.push(`${generated}: expected a generated directory`)
  }

  if (errors.length === 0) {
    console.log(`verify-docs: ${files.length} Markdown file(s) checked.`)
  } else {
    console.error('verify-docs: violations found:')
    for (const error of errors) console.error(`  ${error}`)
    process.exitCode = 1
  }
}
