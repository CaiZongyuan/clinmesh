import { checkThemePackage } from './theme-contrast.ts'
import type { ArchiveFile, Theme, ThemeCheckReport } from './types.ts'
import { THEME_MAX_ASSETS, THEME_PACKAGE_MAX_BYTES } from './types.ts'

const ALLOWED_ASSET_MIME: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] ?? 0)
  }
  return btoa(binary)
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i += 1) {
    crc ^= data[i] ?? 0
    for (let j = 0; j < 8; j += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Zero-dependency uncompressed (STORE) ZIP builder for instant template export. */
export function buildZipArchive(files: readonly ArchiveFile[]): Uint8Array {
  const encoder = new TextEncoder()
  const localParts: Uint8Array[] = []
  const centralParts: Uint8Array[] = []
  let offset = 0

  for (const file of files) {
    const nameBytes = encoder.encode(file.path)
    const crc = crc32(file.data)
    const size = file.data.length

    const local = new Uint8Array(30 + nameBytes.length + size)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x0800, true) // UTF-8
    lv.setUint16(8, 0, true) // STORE
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true)
    lv.setUint32(22, size, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(file.data, 30 + nameBytes.length)
    localParts.push(local)

    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x0800, true)
    cv.setUint16(10, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    centralParts.push(central)

    offset += local.length
  }

  const centralSize = centralParts.reduce((sum, p) => sum + p.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const total = offset + centralSize + eocd.length
  const out = new Uint8Array(total)
  let pos = 0
  for (const part of localParts) { out.set(part, pos); pos += part.length }
  for (const part of centralParts) { out.set(part, pos); pos += part.length }
  out.set(eocd, pos)
  return out
}

async function inflateRawBytes(compressed: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Browser DecompressionStream is unavailable for deflated zip entries.')
  }
  const copy = new Uint8Array(compressed.byteLength)
  copy.set(compressed)
  const stream = new Blob([copy.buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

/** Reads STORE (0) and DEFLATE (8) entries from a `.zip` buffer safely within size bounds. */
export async function readZipArchive(bytes: Uint8Array): Promise<ArchiveFile[]> {
  if (bytes.byteLength > THEME_PACKAGE_MAX_BYTES) {
    throw new Error('Theme archive exceeds the 1 MiB maximum size limit.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocdPos = -1
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 65557); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdPos = i
      break
    }
  }
  if (eocdPos < 0) throw new Error('Invalid .zip archive: missing end-of-central-directory record.')

  const entryCount = view.getUint16(eocdPos + 10, true)
  const cdOffset = view.getUint32(eocdPos + 16, true)
  const decoder = new TextDecoder()
  const files: ArchiveFile[] = []
  let pos = cdOffset
  let totalUncompressed = 0

  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error('Invalid .zip central directory entry.')
    }
    const method = view.getUint16(pos + 10, true)
    const compressedSize = view.getUint32(pos + 20, true)
    const uncompressedSize = view.getUint32(pos + 24, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const localHeaderOffset = view.getUint32(pos + 42, true)
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen))
    pos += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/') || name.includes('..') || name.startsWith('__MACOSX/')) continue
    totalUncompressed += uncompressedSize
    if (totalUncompressed > THEME_PACKAGE_MAX_BYTES) {
      throw new Error('Theme archive uncompressed contents exceed the 1 MiB limit.')
    }

    const localNameLen = view.getUint16(localHeaderOffset + 26, true)
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true)
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen
    const slice = bytes.subarray(dataStart, dataStart + compressedSize)
    let data: Uint8Array
    if (method === 0) {
      data = new Uint8Array(slice)
    } else if (method === 8) {
      data = await inflateRawBytes(slice)
    } else {
      throw new Error(`Unsupported zip compression method ${method}.`)
    }
    files.push({ path: name, data })
  }
  return files
}

export function exportThemeArchive(
  theme: Theme,
  target: { id: string; name: string },
): Uint8Array {
  const encoder = new TextEncoder()
  const manifest = {
    apiVersion: theme.apiVersion,
    id: target.id,
    name: target.name,
    author: 'Custom',
    version: '1.0.0',
    description: typeof theme.description === 'string'
      ? theme.description
      : theme.description?.['zh-CN'] ?? `Based on ${theme.name}`,
    ...(theme.options && theme.options.length > 0 ? { options: theme.options } : {}),
  }
  const files: ArchiveFile[] = [
    { path: `${target.id}/manifest.json`, data: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    { path: `${target.id}/theme.css`, data: encoder.encode(`${theme.css.trim() || '/* Customize ClinMesh semantic tokens here */\n:root.theme-light {\n  --brand: #1764c0;\n}\n'}\n`) },
  ]
  return buildZipArchive(files)
}

export async function inspectThemeZipBytes(bytes: Uint8Array): Promise<ThemeCheckReport> {
  try {
    const entries = await readZipArchive(bytes)
    const decoder = new TextDecoder()
    const normalized = entries.map(e => ({
      path: e.path.replaceAll('\\', '/').replace(/^[^/]+\//, ''),
      rawPath: e.path.replaceAll('\\', '/'),
      data: e.data,
    }))
    const manifestEntry = normalized.find(e => e.rawPath === 'manifest.json' || e.path === 'manifest.json')
    const cssEntry = normalized.find(e => e.rawPath === 'theme.css' || e.path === 'theme.css')
    if (!manifestEntry || !cssEntry) {
      return {
        ok: false,
        issues: [{ level: 'error', code: 'INVALID_MANIFEST', message: 'Theme package must include both manifest.json and theme.css.' }],
        contrast: [],
      }
    }
    const manifest: unknown = JSON.parse(decoder.decode(manifestEntry.data))
    const css = decoder.decode(cssEntry.data)
    const assets: Record<string, string> = {}
    let assetCount = 0
    for (const item of normalized) {
      if (item === manifestEntry || item === cssEntry) continue
      const extMatch = item.path.toLowerCase().match(/\.[a-z0-9]+$/)
      const mime = extMatch ? ALLOWED_ASSET_MIME[extMatch[0]] : undefined
      if (!mime) continue
      assetCount += 1
      if (assetCount > THEME_MAX_ASSETS) {
        return {
          ok: false,
          issues: [{ level: 'error', code: 'INVALID_MANIFEST', message: `Theme package exceeds ${THEME_MAX_ASSETS} bundled assets.` }],
          contrast: [],
        }
      }
      assets[item.path] = `data:${mime};base64,${toBase64(item.data)}`
    }
    return checkThemePackage({ manifest, css, assets })
  } catch (error) {
    return {
      ok: false,
      issues: [{
        level: 'error',
        code: 'INVALID_MANIFEST',
        message: error instanceof Error ? error.message : 'Unable to read theme archive.',
      }],
      contrast: [],
    }
  }
}
