import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, posix, relative, resolve, sep } from 'node:path'
import type { Nodes } from 'mdast'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import { docsPages, type DocsPage } from '../apps/docs/docs.ts'

const root = resolve(import.meta.dirname, '..')
const generatedRoot = resolve(root, 'apps/docs/.generated')

export function resolveRepositoryRef(environment: NodeJS.ProcessEnv): string {
  return environment.DOCS_REPOSITORY_REF ?? 'master'
}

export function resolveRepositoryUrl(environment: NodeJS.ProcessEnv): string {
  return (environment.DOCS_REPOSITORY_URL ?? 'https://github.com/clinmesh/clinmesh').replace(/\/$/, '')
}

interface Replacement {
  start: number
  end: number
  value: string
}

interface DestinationRange {
  start: number
  end: number
}

type RewritableNode = Extract<Nodes, { type: 'link' | 'image' | 'definition' }>

export interface RewriteMarkdownOptions {
  sourcePath: string
  route: string
  pages: DocsPage[]
  repoRoot: string
  repositoryRef: string
  repositoryUrl: string
  placeImage?: (absPath: string) => string
}

function repoPath(absPath: string, repoRoot: string): string {
  return relative(repoRoot, absPath).split(sep).join('/')
}

function isExternalOrSiteAbsolute(url: string): boolean {
  return url.startsWith('#')
    || url.startsWith('//')
    || url.startsWith('/')
    || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

function skipWhitespace(source: string, start: number): number {
  let index = start
  while (/\s/.test(source[index] ?? '')) index += 1
  return index
}

function labelEnd(source: string): number {
  const first = source.indexOf('[')
  if (first === -1) return -1
  let depth = 0
  for (let index = first; index < source.length; index += 1) {
    const char = source[index]
    if (char === '\\') index += 1
    else if (char === '[') depth += 1
    else if (char === ']') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function destinationRange(rawNode: string, type: 'link' | 'image' | 'definition'): DestinationRange {
  const endOfLabel = labelEnd(rawNode)
  if (endOfLabel === -1) throw new Error(`project-doc-site: cannot locate label end in ${JSON.stringify(rawNode)}.`)

  let start: number
  if (type === 'definition') {
    const colon = rawNode.indexOf(':', endOfLabel + 1)
    if (colon === -1) throw new Error(`project-doc-site: cannot locate definition separator in ${JSON.stringify(rawNode)}.`)
    start = skipWhitespace(rawNode, colon + 1)
  } else {
    if (rawNode[endOfLabel + 1] !== '(') throw new Error(`project-doc-site: cannot locate inline destination in ${JSON.stringify(rawNode)}.`)
    start = skipWhitespace(rawNode, endOfLabel + 2)
  }

  if (rawNode[start] === '<') {
    for (let index = start + 1; index < rawNode.length; index += 1) {
      if (rawNode[index] === '\\') index += 1
      else if (rawNode[index] === '>') return { start: start + 1, end: index }
    }
    throw new Error(`project-doc-site: cannot locate angle-bracket destination end in ${JSON.stringify(rawNode)}.`)
  }

  let depth = 0
  for (let index = start; index < rawNode.length; index += 1) {
    const char = rawNode[index]
    if (char === '\\') index += 1
    else if (char === '(') depth += 1
    else if (char === ')') {
      if (depth === 0) return { start, end: index }
      depth -= 1
    } else if (/\s/.test(char ?? '') && depth === 0) return { start, end: index }
  }
  return { start, end: rawNode.length }
}

function splitTarget(url: string): { path: string; suffix: string } {
  const boundary = url.search(/[?#]/)
  if (boundary === -1) return { path: url, suffix: '' }
  return { path: url.slice(0, boundary), suffix: url.slice(boundary) }
}

function decodePath(path: string): string {
  try {
    return decodeURIComponent(path)
  } catch {
    throw new Error(`project-doc-site: malformed percent escape in ${JSON.stringify(path)}.`)
  }
}

function routeTarget(fromRoute: string, toRoute: string, suffix: string): string {
  const target = posix.relative(posix.dirname(fromRoute), toRoute)
  return `${target.startsWith('.') ? target : `./${target}`}${suffix}`
}

function sourceMap(pages: DocsPage[]): Map<string, DocsPage> {
  const map = new Map<string, DocsPage>()
  for (const page of pages) {
    for (const source of [page.source, ...(page.sourceAliases ?? [])]) {
      if (map.has(source)) throw new Error(`project-doc-site: duplicate source or alias ${JSON.stringify(source)}.`)
      map.set(source, page)
    }
  }
  return map
}

function resolveRepositoryTarget(sourceAbs: string, rawPath: string, repoRoot: string): { absPath: string; line?: number } {
  const decoded = decodePath(rawPath)
  let absPath = resolve(dirname(sourceAbs), decoded)
  if (existsSync(absPath)) return { absPath }

  const lineMatch = decoded.match(/:(\d+)$/)
  if (lineMatch !== null) {
    const line = lineMatch[1]
    if (line === undefined) throw new Error('project-doc-site: line suffix matched without a line number.')
    absPath = resolve(dirname(sourceAbs), decoded.slice(0, -lineMatch[0].length))
    if (existsSync(absPath)) return { absPath, line: Number.parseInt(line, 10) }
  }

  if (extname(decoded) === '') {
    const markdown = resolve(dirname(sourceAbs), `${decoded}.md`)
    if (existsSync(markdown)) return { absPath: markdown }
    const index = resolve(dirname(sourceAbs), decoded, 'index.md')
    if (existsSync(index)) return { absPath: index }
  }

  throw new Error(`project-doc-site: ${repoPath(sourceAbs, repoRoot)} links to missing path ${JSON.stringify(rawPath)}.`)
}

function repositoryTarget(
  absPath: string,
  line: number | undefined,
  suffix: string,
  repositoryRef: string,
  repositoryUrl: string,
  repoRoot: string,
): string {
  const path = repoPath(absPath, repoRoot)
  const kind = lstatSync(absPath).isDirectory() ? 'tree' : 'blob'
  const targetSuffix = line === undefined ? suffix : `#L${line}`
  return `${repositoryUrl}/${kind}/${repositoryRef}/${path}${targetSuffix}`
}

export function rewriteMarkdown(source: string, options: RewriteMarkdownOptions): string {
  const sourceAbs = resolve(options.repoRoot, options.sourcePath)
  const published = sourceMap(options.pages)
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const replacements: Replacement[] = []

  const rewrite = (node: RewritableNode): void => {
    if (isExternalOrSiteAbsolute(node.url)) return
    const { path, suffix } = splitTarget(node.url)
    if (path === '') return
    const { absPath, line } = resolveRepositoryTarget(sourceAbs, path, options.repoRoot)
    const targetPath = repoPath(absPath, options.repoRoot)
    const publishedPage = published.get(targetPath)
    const nextUrl = publishedPage !== undefined
      ? routeTarget(options.route, publishedPage.route, suffix)
      : node.type === 'image' && options.placeImage !== undefined
        ? `${options.placeImage(absPath)}${suffix}`
        : repositoryTarget(absPath, line, suffix, options.repositoryRef, options.repositoryUrl, options.repoRoot)

    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) throw new Error(`project-doc-site: link ${JSON.stringify(node.url)} has no source offsets.`)
    const range = destinationRange(source.slice(start, end), node.type)
    replacements.push({ start: start + range.start, end: start + range.end, value: nextUrl })
  }

  const visit = (node: Nodes): void => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && 'url' in node) rewrite(node)
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)

  let projected = source
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    projected = projected.slice(0, replacement.start) + replacement.value + projected.slice(replacement.end)
  }
  return projected
}

export function addProjectionFrontmatter(markdown: string, page: Pick<DocsPage, 'source' | 'outline'>): string {
  const fields = [
    `editSource: ${JSON.stringify(page.source)}`,
    ...(page.outline === undefined ? [] : [`outline: ${JSON.stringify(page.outline)}`]),
  ].join('\n')
  if (markdown.startsWith('---\n')) return markdown.replace('---\n', `---\n${fields}\n`)
  return `---\n${fields}\n---\n\n${markdown}`
}

export function publishableImage(absPath: string, repoRoot: string): string | undefined {
  const real = realpathSync(absPath)
  const inside = real === repoRoot || real.startsWith(`${repoRoot}${sep}`)
  return inside && statSync(real).isFile() ? real : undefined
}

function referencedImages(): string[] {
  const found = new Set<string>()
  for (const page of docsPages) {
    const sourceAbs = resolve(root, page.source)
    if (!existsSync(sourceAbs)) continue
    rewriteMarkdown(readFileSync(sourceAbs, 'utf8'), {
      sourcePath: page.source,
      route: page.route,
      pages: docsPages,
      repoRoot: root,
      repositoryRef: resolveRepositoryRef(process.env),
      repositoryUrl: resolveRepositoryUrl(process.env),
      placeImage: (absPath) => {
        const real = publishableImage(absPath, root)
        if (real !== undefined) found.add(real)
        return ''
      },
    })
  }
  return [...found]
}

export function docsSourceFiles(): string[] {
  return [...new Set([...docsPages.map(page => resolve(root, page.source)), ...referencedImages()])]
}

export function projectDocs(): void {
  const routes = new Set<string>()
  const claimed = new Map<string, string>()
  const repositoryRef = resolveRepositoryRef(process.env)
  const repositoryUrl = resolveRepositoryUrl(process.env)
  rmSync(generatedRoot, { recursive: true, force: true })

  const claim = (target: string, sourceAbs: string): void => {
    const holder = claimed.get(target)
    if (holder !== undefined && holder !== sourceAbs) {
      throw new Error(`project-doc-site: ${repoPath(sourceAbs, root)} and ${repoPath(holder, root)} both project to ${repoPath(target, generatedRoot)}.`)
    }
    claimed.set(target, sourceAbs)
  }

  for (const page of docsPages) {
    if (routes.has(page.route)) throw new Error(`project-doc-site: duplicate route ${JSON.stringify(page.route)}.`)
    routes.add(page.route)
    const sourceAbs = resolve(root, page.source)
    if (!existsSync(sourceAbs) || !lstatSync(sourceAbs).isFile()) throw new Error(`project-doc-site: source ${JSON.stringify(page.source)} does not exist or is not a file.`)
    const output = resolve(generatedRoot, page.route)
    claim(output, sourceAbs)
    mkdirSync(dirname(output), { recursive: true })
    const projected = rewriteMarkdown(readFileSync(sourceAbs, 'utf8'), {
      sourcePath: page.source,
      route: page.route,
      pages: docsPages,
      repoRoot: root,
      repositoryRef,
      repositoryUrl,
      placeImage: (absPath) => {
        const real = publishableImage(absPath, root)
        if (real === undefined) throw new Error(`project-doc-site: ${page.source} references an image outside the repository.`)
        const name = basename(real)
        const target = resolve(dirname(output), name)
        claim(target, real)
        copyFileSync(real, target)
        return `./${encodeURI(name)}`
      },
    })
    writeFileSync(output, addProjectionFrontmatter(projected, page))
  }
}
