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
  return environment.DOCS_REPOSITORY_REF ?? 'main'
}

export function resolveRepositoryUrl(environment: NodeJS.ProcessEnv): string {
  return (environment.DOCS_REPOSITORY_URL ?? 'https://github.com/CaiZongyuan/clinmesh').replace(/\/$/, '')
}

export function slugifyHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\-\s]/gu, '')
    .replace(/\s/g, '-')
}

function headingText(node: Nodes): string {
  if ('value' in node && typeof node.value === 'string') {
    return node.type === 'html' ? '' : node.value
  }
  if ('children' in node) return node.children.map(headingText).join('')
  return ''
}

const HTML_OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9:-]*)(?:\s+((?:[^>"']|"[^"]*"|'[^']*')*))?\/?>/g
const HTML_ATTRIBUTE = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const HTML_ATTR_CHAR_REF = /&(?:#(?:[xX]([0-9A-Fa-f]+)|([0-9]+));?|([A-Za-z][A-Za-z0-9]*)(;?))/g
const LEADING_FRONTMATTER = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/

const HTML_C1_REPLACEMENTS = new Map<number, number>([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e],
  [0x85, 0x2026], [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6],
  [0x89, 0x2030], [0x8a, 0x0160], [0x8b, 0x2039], [0x8c, 0x0152],
  [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019], [0x93, 0x201c],
  [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a],
  [0x9c, 0x0153], [0x9e, 0x017e], [0x9f, 0x0178],
])

const LEGACY_NAMED_ENTITIES = new Set([
  'AElig', 'AMP', 'Aacute', 'Acirc', 'Agrave', 'Aring', 'Atilde', 'Auml',
  'COPY', 'Ccedil', 'ETH', 'Eacute', 'Ecirc', 'Egrave', 'Euml', 'GT',
  'Iacute', 'Icirc', 'Igrave', 'Iuml', 'LT', 'Ntilde', 'Oacute', 'Ocirc',
  'Ograve', 'Oslash', 'Otilde', 'Ouml', 'QUOT', 'REG', 'THORN', 'Uacute',
  'Ucirc', 'Ugrave', 'Uuml', 'Yacute', 'aacute', 'acirc', 'acute', 'aelig',
  'agrave', 'amp', 'aring', 'atilde', 'auml', 'brvbar', 'ccedil', 'cedil',
  'cent', 'copy', 'curren', 'deg', 'divide', 'eacute', 'ecirc', 'egrave',
  'eth', 'euml', 'frac12', 'frac14', 'frac34', 'gt', 'iacute', 'icirc',
  'iexcl', 'igrave', 'iquest', 'iuml', 'laquo', 'lt', 'macr', 'micro',
  'middot', 'nbsp', 'not', 'ntilde', 'oacute', 'ocirc', 'ograve', 'ordf',
  'ordm', 'oslash', 'otilde', 'ouml', 'para', 'plusmn', 'pound', 'quot',
  'raquo', 'reg', 'sect', 'shy', 'sup1', 'sup2', 'sup3', 'szlig', 'thorn',
  'times', 'uacute', 'ucirc', 'ugrave', 'uml', 'uuml', 'yacute', 'yen', 'yuml',
])

const NAMED_ENTITY_CACHE = new Map<string, string | undefined>()

function decodeSemicolonNamedEntity(entity: string): string | undefined {
  if (NAMED_ENTITY_CACHE.has(entity)) return NAMED_ENTITY_CACHE.get(entity)
  const tree = fromMarkdown(`a${entity}b`)
  const first = tree.children[0]
  const text = first?.type === 'paragraph'
    ? first.children.map(child => ('value' in child && typeof child.value === 'string' ? child.value : '')).join('').slice(1, -1)
    : entity
  const resolved = text === entity ? undefined : text
  NAMED_ENTITY_CACHE.set(entity, resolved)
  return resolved
}

function decodeNumericEntity(digits: string, base: 10 | 16): string {
  let code = 0
  for (const ch of digits) {
    code = code * base + Number.parseInt(ch, base)
    if (code > 0x110000) {
      code = 0x110000
      break
    }
  }
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd'
  return String.fromCodePoint(HTML_C1_REPLACEMENTS.get(code) ?? code)
}

function decodeHtmlAttribute(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(
    HTML_ATTR_CHAR_REF,
    (match, hex: string | undefined, dec: string | undefined, name: string | undefined, semi: string | undefined, offset: number) => {
      if (hex !== undefined) return decodeNumericEntity(hex, 16)
      if (dec !== undefined) return decodeNumericEntity(dec, 10)
      if (name !== undefined) {
        if (semi === ';') return decodeSemicolonNamedEntity(`&${name};`) ?? match
        if (value[offset + match.length] !== '=' && LEGACY_NAMED_ENTITIES.has(name)) {
          return decodeSemicolonNamedEntity(`&${name};`) ?? match
        }
      }
      return match
    },
  )
}

function collectHtmlAnchors(rawHtml: string, anchors: Set<string>): void {
  const sanitized = rawHtml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  for (const tagMatch of sanitized.matchAll(HTML_OPEN_TAG)) {
    const tagName = tagMatch[1]?.toLowerCase()
    const attributes = tagMatch[2] ?? ''
    for (const attrMatch of attributes.matchAll(HTML_ATTRIBUTE)) {
      const attrName = attrMatch[1]?.toLowerCase()
      if (attrName !== 'id' && !(tagName === 'a' && attrName === 'name')) continue
      const rawValue = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4]
      if (rawValue === undefined) continue
      const value = decodeHtmlAttribute(rawValue)
      if (value !== '') anchors.add(value)
    }
  }
}

export function collectMarkdownAnchors(markdown: string): Set<string> {
  const body = markdown.replace(LEADING_FRONTMATTER, '')
  const tree = fromMarkdown(body, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const anchors = new Set<string>()
  const headingSlugs = new Set<string>()

  const visit = (node: Nodes): void => {
    if (node.type === 'html') {
      collectHtmlAnchors(node.value, anchors)
    }
    if (node.type === 'heading') {
      const base = slugifyHeading(headingText(node))
      if (base !== '') {
        let slug = base
        let suffix = 1
        while (headingSlugs.has(slug)) {
          slug = `${base}-${suffix}`
          suffix += 1
        }
        headingSlugs.add(slug)
        anchors.add(slug)
      }
    }
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(tree)
  return anchors
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
