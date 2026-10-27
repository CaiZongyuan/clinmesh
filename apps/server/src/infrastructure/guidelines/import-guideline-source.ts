import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GuidelineDocument, GuidelinePassage, GuidelineSourceDefinition } from '../../application/guideline-corpus.ts'

const maximumBytes = 32 * 1024 * 1024

function officialUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !['gov.cn', 'nhc.gov.cn', 'who.int'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error('Guideline sources require an official HTTPS URL without credentials or a custom port')
  }
  return url
}

async function download(url: URL, fetchImplementation: typeof fetch) {
  const signal = AbortSignal.timeout(60_000)
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetchImplementation(url.href, { redirect: 'manual', signal })
    if (response.url) officialUrl(response.url)
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel()
      const location = response.headers.get('location')
      if (redirects >= 5 || location === null) throw new Error('Guideline redirect limit exceeded or target missing')
      url = officialUrl(new URL(location, url).href)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Guideline download failed with HTTP ${response.status}`)
    }
    if (Number(response.headers.get('content-length')) > maximumBytes) {
      await response.body?.cancel()
      throw new Error(`Guideline download exceeds ${maximumBytes} bytes`)
    }
    if (response.body === null) throw new Error('Guideline download returned no original bytes')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        size += next.value.byteLength
        if (size > maximumBytes) throw new Error(`Guideline download exceeds ${maximumBytes} bytes`)
        chunks.push(next.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
    return Buffer.concat(chunks, size)
  }
}

function sha256(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function readCached(path: string) {
  const file = await open(path, 'r').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (file === undefined) return undefined
  try {
    if ((await file.stat()).size > maximumBytes) throw new Error(`Guideline cache exceeds ${maximumBytes} bytes`)
    const bytes = await file.readFile()
    if (bytes.byteLength > maximumBytes) throw new Error(`Guideline cache exceeds ${maximumBytes} bytes`)
    return bytes
  } finally { await file.close() }
}

function passagesFromText(text: string, prefix = ''): GuidelinePassage[] {
  if (!text.trim() || text.includes('\0') || /^\s*(?:%PDF-|<!doctype\s+html|<html\b)/i.test(text)) {
    throw new Error('Guideline source does not contain readable original text')
  }
  const units: Array<{ start: number; end: number; firstLine: number; lastLine: number }> = []
  let start = 0
  let firstLine = 1
  let lineNumber = 0
  for (const line of text.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    lineNumber += 1
    const end = line.index + line[0].length
    if (line[0].trim() === '' || /[.!?。！？]["'”’）)\]]*$/.test(line[0].trim())) {
      units.push({ start, end, firstLine, lastLine: lineNumber })
      start = end
      firstLine = lineNumber + 1
    }
  }
  if (start < text.length) units.push({ start, end: text.length, firstLine, lastLine: lineNumber })
  const passages: GuidelinePassage[] = []
  let current = { start: 0, end: 0, firstLine: 1, lastLine: 1 }
  let previous: typeof current | undefined
  const flush = () => passages.push({
    locator: `${prefix}原文第 ${current.firstLine}–${current.lastLine} 行；字符 [${current.start}, ${current.end})`,
    text: text.slice(current.start, current.end),
  })
  for (const unit of units) {
    if (unit.end - unit.start > 12_000) throw new Error('A complete guideline passage exceeds 12000 characters and cannot be safely split')
    if (unit.end - current.start > 12_000) {
      flush()
      // 保留上一完整句作为相邻上下文；连同下一句超限时仍保留连续原文覆盖。
      current = previous !== undefined && unit.end - previous.start <= 12_000 ? { ...previous } : { ...unit }
    }
    current.end = unit.end
    current.lastLine = unit.lastLine
    previous = unit
  }
  flush()
  return passages
}

export async function extractGuidelinePdf(bytes: Uint8Array, includedPages?: ReadonlySet<number>): Promise<GuidelinePassage[]> {
  if (Buffer.from(bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') throw new Error('Guideline source has no PDF signature')
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const directory = dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json')))
  const task = getDocument({
    data: Uint8Array.from(bytes), stopAtErrors: true, useWorkerFetch: false,
    cMapUrl: join(directory, 'cmaps/'), standardFontDataUrl: join(directory, 'standard_fonts/'),
  })
  try {
    const document = await task.promise
    if (includedPages !== undefined && [...includedPages].some(page => page > document.numPages)) {
      throw new Error('Selected guideline page exceeds the original PDF page count')
    }
    const passages: GuidelinePassage[] = []
    for (let number = 1; number <= document.numPages; number += 1) {
      if (includedPages !== undefined && !includedPages.has(number)) continue
      const page = await document.getPage(number)
      const content = await page.getTextContent({ disableNormalization: true })
      const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : '') : '').join('')
      if (!text.trim()) {
        const operators = await page.getOperatorList()
        if (!operators.fnArray.every(operation => [OPS.save, OPS.restore, OPS.transform].includes(operation))) {
          throw new Error(`PDF physical page ${number} has no readable original text; visible content cannot be silently omitted`)
        }
      } else passages.push(...passagesFromText(text, `PDF 物理第 ${number} 页；提取文本`))
      page.cleanup()
    }
    if (passages.length === 0) throw new Error('PDF source does not contain readable original text')
    return passages
  } finally { await task.destroy() }
}

export async function importGuidelineSource(source: GuidelineSourceDefinition, options: {
  cacheDirectory: string; fetch?: typeof fetch
}): Promise<GuidelineDocument> {
  if (source.downloadUrl === undefined) throw new Error('Guideline downloads require an official HTTPS URL')
  const url = officialUrl(source.downloadUrl)
  if (!/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error('Invalid guideline SHA-256')
  await mkdir(options.cacheDirectory, { recursive: true })
  const path = join(options.cacheDirectory, `${source.sha256}.${source.format}`)
  const cached = await readCached(path)
  const reusable = cached !== undefined && sha256(cached) === source.sha256
  const bytes = reusable ? cached : await download(url, options.fetch ?? fetch)
  if (sha256(bytes) !== source.sha256) throw new Error('Guideline SHA-256 does not match its registered source')
  const passages = source.format === 'pdf' ? await extractGuidelinePdf(bytes)
    : passagesFromText(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes))
  if (!reusable) {
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, bytes, { flag: 'wx' })
      await rename(temporary, path)
    } finally { await rm(temporary, { force: true }) }
  }
  return { source, passages }
}
