import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GuidelineSourceDefinition } from '../src/application/guideline-corpus.ts'
import { importGuidelineSource } from '../src/infrastructure/guidelines/import-guideline-source.ts'
import { syntheticGuidelinePdf } from './fixtures/synthetic-guideline-pdf.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function cacheDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'clinmesh-guideline-import-'))
  directories.push(path)
  return path
}

const original = '第一章 适用范围\n仅限合成成年人，阴性结果不能排除。\n\n第二章 随访\n尚未明确时应复核。\n'
function sourceFor(bytes: Uint8Array | string, changes: Partial<GuidelineSourceDefinition> = {}): GuidelineSourceDefinition {
  return {
    id: 'synthetic-who-guideline', title: '合成指南', publisher: '合成发布者', documentType: 'guideline',
    version: '2026', url: 'https://www.who.int/publications/synthetic',
    downloadUrl: 'https://iris.who.int/server/api/core/bitstreams/synthetic/content', format: 'text',
    sha256: createHash('sha256').update(bytes).digest('hex'), scope: '仅限合成病例', status: 'active',
    license: { id: 'synthetic-unverified', url: 'https://www.who.int/about/policies/publishing/copyright', usage: 'unverified' },
    topics: [{ terms: ['合成主题'], diagnosisQueries: ['合成主题'] }], ...changes,
  }
}

describe('free guideline source import', () => {
  it('imports original UTF-8 text with source metadata and exact line and character locations', async () => {
    const source = sourceFor(original)
    const imported = await importGuidelineSource(source, {
      cacheDirectory: await cacheDirectory(), fetch: async () => new Response(original),
    })

    expect(imported.source).toEqual(source)
    expect(imported.passages).toEqual([{ locator: `原文第 1–5 行；字符 [0, ${original.length})`, text: original }])
  })

  it('reuses verified original bytes and repairs a corrupt cache before returning evidence', async () => {
    const cache = await cacheDirectory()
    const source = sourceFor(original)
    let requests = 0
    const options = { cacheDirectory: cache, fetch: async () => { requests += 1; return new Response(original) } }
    const imported = await importGuidelineSource(source, options)
    expect(await importGuidelineSource(source, options)).toEqual(imported)
    expect(requests).toBe(1)
    const files = await readdir(cache)
    expect(files).toHaveLength(1)
    const file = join(cache, files[0]!)
    expect(await readFile(file)).toEqual(Buffer.from(original))

    await writeFile(file, 'corrupt cache')
    expect(await importGuidelineSource(source, options)).toEqual(imported)
    expect(requests).toBe(2)
    expect(await readFile(file)).toEqual(Buffer.from(original))
  })

  it('does not send a local-only publication to the official download transport', async () => {
    const { downloadUrl: _downloadUrl, ...source } = sourceFor(original)
    let requested = false
    await expect(importGuidelineSource(source, {
      cacheDirectory: await cacheDirectory(), fetch: async () => { requested = true; return new Response(original) },
    })).rejects.toThrow('official HTTPS URL')
    expect(requested).toBe(false)
  })

  it('rejects an incorrect update hash without replacing an existing usable version or leaving temporary files', async () => {
    const cache = await cacheDirectory()
    const source = sourceFor(original)
    const previous = await importGuidelineSource(source, { cacheDirectory: cache, fetch: async () => new Response(original) })
    const before = await readdir(cache)
    await expect(importGuidelineSource({ ...source, version: '2027', sha256: 'a'.repeat(64) }, {
      cacheDirectory: cache, fetch: async () => new Response('A corrupted update.'),
    })).rejects.toThrow('SHA-256')
    expect(await readdir(cache)).toEqual(before)
    expect(await importGuidelineSource(source, {
      cacheDirectory: cache, fetch: async () => { throw new Error('The old version must use its cache') },
    })).toEqual(previous)
  })

  it.each([
    'http://www.who.int/source', 'https://127.0.0.1/source', 'https://[::1]/source',
    'https://www.who.int.evil.example/source', 'https://evil.example/gov.cn/source',
    'https://user:password@iris.who.int/source', 'https://iris.who.int:8443/source',
  ])('rejects an untrusted download URL before requesting it: %s', async downloadUrl => {
    let requested = false
    await expect(importGuidelineSource(sourceFor(original, { downloadUrl }), {
      cacheDirectory: await cacheDirectory(), fetch: async () => { requested = true; return new Response(original) },
    })).rejects.toThrow('official HTTPS')
    expect(requested).toBe(false)
  })

  it('follows a bounded official redirect while explicitly disabling automatic redirects', async () => {
    const requested: string[] = []
    const source = sourceFor(original, { downloadUrl: 'https://www.who.int/registered-download' })
    const imported = await importGuidelineSource(source, {
      cacheDirectory: await cacheDirectory(), fetch: async (input, init) => {
        expect(init?.redirect).toBe('manual')
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        requested.push(String(input))
        return requested.length === 1
          ? new Response(null, { status: 302, headers: { location: 'https://iris.who.int/registered-text' } })
          : new Response(original)
      },
    })
    expect(imported.passages[0]?.text).toBe(original)
    expect(requested).toEqual(['https://www.who.int/registered-download', 'https://iris.who.int/registered-text'])
  })

  it.each(['https://evil.example/secret', 'https://127.0.0.1/secret', 'http://www.who.int/secret'])
    ('rejects an untrusted redirect target without requesting it: %s', async location => {
      let requests = 0
      await expect(importGuidelineSource(sourceFor(original), {
        cacheDirectory: await cacheDirectory(), fetch: async () => {
          requests += 1
          return new Response(null, { status: 302, headers: { location } })
        },
      })).rejects.toThrow('official HTTPS')
      expect(requests).toBe(1)
    })

  it('stops redirect loops and does not cache failed HTTP responses', async () => {
    const cache = await cacheDirectory()
    let requests = 0
    await expect(importGuidelineSource(sourceFor(original), {
      cacheDirectory: cache, fetch: async () => {
        requests += 1
        return new Response(null, { status: 302, headers: { location: '/loop' } })
      },
    })).rejects.toThrow('redirect')
    expect(requests).toBeLessThanOrEqual(6)
    await expect(importGuidelineSource(sourceFor(original), {
      cacheDirectory: cache, fetch: async () => new Response(original, { status: 503 }),
    })).rejects.toThrow('HTTP 503')
    expect(await readdir(cache)).toEqual([])
  })

  it.each(['declared', 'streamed'])('bounds %s response bytes and cancels their body', async kind => {
    let cancelled = false
    const cache = await cacheDirectory()
    await expect(importGuidelineSource(sourceFor(original), {
      cacheDirectory: cache, fetch: async () => new Response(new ReadableStream({
        start(controller) { controller.enqueue(kind === 'streamed' ? new Uint8Array(32 * 1024 * 1024 + 1) : new Uint8Array(1)) },
        pull() { throw new Error('The oversized response was read past its limit') },
        cancel() { cancelled = true },
      }, { highWaterMark: 0 }), kind === 'declared' ? { headers: { 'content-length': String(32 * 1024 * 1024 + 1) } } : {}),
    })).rejects.toThrow('exceeds')
    expect(cancelled).toBe(true)
    expect(await readdir(cache)).toEqual([])
  })

  it('preserves every original character across bounded overlapping passages and does not split a conditional sentence', async () => {
    const condition = '阴性结果不能排除疾病，\r\n只有完整复核且病史支持时，才考虑改变处置。\r\n'
    const text = '第三章 合成适用范围\r\n' + condition.repeat(700) + '\r\n附注：仍有不确定性。\r\n'
    const document = await importGuidelineSource(sourceFor(text), {
      cacheDirectory: await cacheDirectory(), fetch: async () => new Response(text),
    })
    const reconstructed = Array.from({ length: text.length }, () => '')
    expect(document.passages.length).toBeGreaterThan(1)
    const first = /字符 \[(\d+), (\d+)\)/.exec(document.passages[0]!.locator)!
    const second = /字符 \[(\d+), (\d+)\)/.exec(document.passages[1]!.locator)!
    expect(Number(second[1])).toBeLessThan(Number(first[2]))
    for (const passage of document.passages) {
      const location = /字符 \[(\d+), (\d+)\)/.exec(passage.locator)
      expect(location).not.toBeNull()
      const start = Number(location![1])
      const end = Number(location![2])
      expect(passage.text).toBe(text.slice(start, end))
      expect(passage.text.length).toBeLessThanOrEqual(12_000)
      expect(passage.text).not.toMatch(/阴性结果不能排除疾病，\r\n$/)
      expect(passage.text).not.toMatch(/^只有完整复核/)
      for (let index = start; index < end; index += 1) reconstructed[index] = passage.text[index - start]!
    }
    expect(reconstructed.join('')).toBe(text)
    expect(document.source.sha256).toBe(sourceFor(text).sha256)
  })

  it('rejects an indivisible oversized passage without truncating or caching it', async () => {
    const text = '不可分割的完整字段'.repeat(1500)
    const cache = await cacheDirectory()
    await expect(importGuidelineSource(sourceFor(text), {
      cacheDirectory: cache, fetch: async () => new Response(text),
    })).rejects.toThrow('12000')
    expect(await readdir(cache)).toEqual([])
  })

  it('rejects invalid UTF-8 original bytes instead of replacing them', async () => {
    const bytes = new Uint8Array([0xc3, 0x28])
    await expect(importGuidelineSource(sourceFor(bytes), {
      cacheDirectory: await cacheDirectory(), fetch: async () => new Response(bytes),
    })).rejects.toThrow(/utf-8/i)
  })

  it.each(['', ' \n\t', '<!DOCTYPE html><html><body>Access denied</body></html>', '\u0000binary', '%PDF-1.7\nDeclared as text.'])
    ('rejects data without readable original text: %j', async text => {
      await expect(importGuidelineSource(sourceFor(text), {
        cacheDirectory: await cacheDirectory(), fetch: async () => new Response(text),
      })).rejects.toThrow('readable original text')
    })

  it('extracts real PDF original statements and locates them on their physical pages', async () => {
    const pages = [
      ['1. Synthetic assessment', 'A negative test does not rule out disease.'],
      ['2. Follow-up', 'Only change treatment after confirming the original conditions.'],
    ]
    const bytes = syntheticGuidelinePdf(pages)
    const source = sourceFor(bytes, { format: 'pdf', downloadUrl: 'https://www.gov.cn/synthetic-guideline.pdf' })
    const document = await importGuidelineSource(source, {
      cacheDirectory: await cacheDirectory(), fetch: async () => new Response(bytes),
    })
    expect(document.passages).toHaveLength(2)
    for (const [index, passage] of document.passages.entries()) {
      expect(passage.locator).toContain(`PDF 物理第 ${index + 1} 页`)
      expect(passage.text.split('\n').filter(Boolean)).toEqual(pages[index])
    }
    expect(document.source).toEqual(source)
  })

  it.each(['not a PDF', '%PDF-1.7\nBroken original data.'])('rejects invalid PDF original data: %s', async text => {
    await expect(importGuidelineSource(sourceFor(text, { format: 'pdf' }), {
      cacheDirectory: await cacheDirectory(), fetch: async () => new Response(text),
    })).rejects.toThrow(/PDF/)
  })

  it('rejects a PDF page without extractable text rather than silently omitting that page', async () => {
    const bytes = syntheticGuidelinePdf([['The first physical page has clinical text.'], { operators: '0 0 10 10 re f\n' }])
    await expect(importGuidelineSource(sourceFor(bytes, { format: 'pdf' }), {
      cacheDirectory: await cacheDirectory(), fetch: async () => new Response(bytes),
    })).rejects.toThrow('PDF physical page 2')
  })

  it('skips provably blank PDF pages while keeping subsequent physical page numbers', async () => {
    const bytes = syntheticGuidelinePdf([
      ['First physical page: preserve this negative finding.'], [],
      { operators: 'q\nQ\n' }, ['Fourth physical page: the condition remains uncertain.'],
    ])
    const document = await importGuidelineSource(sourceFor(bytes, { format: 'pdf' }), {
      cacheDirectory: await cacheDirectory(), fetch: async () => new Response(bytes),
    })
    expect(document.passages).toHaveLength(2)
    expect(document.passages[0]).toMatchObject({ locator: expect.stringContaining('PDF 物理第 1 页'),
      text: 'First physical page: preserve this negative finding.' })
    expect(document.passages[1]).toMatchObject({ locator: expect.stringContaining('PDF 物理第 4 页'),
      text: 'Fourth physical page: the condition remains uncertain.' })
  })

  it('rejects a PDF containing only blank pages', async () => {
    const bytes = syntheticGuidelinePdf([[], []])
    await expect(importGuidelineSource(sourceFor(bytes, { format: 'pdf' }), {
      cacheDirectory: await cacheDirectory(), fetch: async () => new Response(bytes),
    })).rejects.toThrow('readable original text')
  })

  it('rejects an oversized cached original before returning it or calling the network', async () => {
    const bytes = new Uint8Array(32 * 1024 * 1024 + 1).fill(65)
    const source = sourceFor(bytes)
    const cache = await cacheDirectory()
    await writeFile(join(cache, `${source.sha256}.text`), bytes)
    let requested = false
    await expect(importGuidelineSource(source, {
      cacheDirectory: cache, fetch: async () => { requested = true; return new Response(original) },
    })).rejects.toThrow('cache exceeds')
    expect(requested).toBe(false)
  })
})
