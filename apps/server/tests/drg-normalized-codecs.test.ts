import { describe, expect, it } from 'vitest'
import { buildNormalizedArtifacts, renderNormalizedRecipe } from '../src/infrastructure/reference-data/drg-normalized-codecs.ts'

const packageRoot = '.data/prepared'
const inputPackage = {
  id: 'synthetic-prepared', format: 'prepared-catalogues-v1' as const, root: packageRoot,
  version: 'synthetic-v1', manifest: { path: 'manifest.json', sha256: '0'.repeat(64) },
  sourceUrl: 'https://example.test/prepared', quarantineReasons: ['usage-terms-unconfirmed' as const],
}

function fixture(files: Record<string, string>) {
  const source = new Map<string, Buffer>(Object.entries(files).map(([path, value]) => [`${packageRoot}/${path}`, Buffer.from(value)]))
  source.set(`${packageRoot}/manifest.json`, Buffer.from(JSON.stringify({ files: Object.keys(files).map(path => ({ path })) })))
  return { source, read: async (path: string) => {
    const value = source.get(path)
    if (value === undefined) throw new Error(`Missing fixture: ${path}`)
    return value
  } }
}

describe('DRG normalized source artifacts', () => {
  it('roundtrips readiness identities and complete status templates with their original bytes', async () => {
    const original = '\ufeff{"id":"r1","table":"icd10","recordId":"s1","code":"A","name":"合成\\\"名称","runtimeEnabled":false,"numericFact":151.0}\r\n'
      + '{"id":"r2","table":"icd10","recordId":"s2","code":"B","name":"合成记录","runtimeEnabled":false,"numericFact":151.0}\r\n'
      + '{"id":"r3","table":"services","recordId":"s3","name":null,"missingFields":["price"],"runtimeEnabled":false}\r\n'
    const input = fixture({ 'assessment/record-readiness.jsonl': original })
    const result = await buildNormalizedArtifacts({ packages: [inputPackage], storageRoot: '.data/compact', read: input.read })
    for (const [path, bytes] of result.artifacts) input.source.set(path, bytes)
    const recipe = result.recipes.get(`${packageRoot}/assessment/record-readiness.jsonl`)
    expect(recipe).toBeDefined()
    expect(await renderNormalizedRecipe(recipe!, input.read)).toEqual(Buffer.from(original))
    if (recipe?.kind !== 'readiness-templates') throw new Error('Expected readiness templates')
    expect(JSON.parse(input.source.get(recipe.templatesPath)!.toString('utf8'))).toHaveLength(2)
  })

  it('retains every member of a repeated code and reconstructs its exact source from zero-based page lines', async () => {
    const source = '{"archiveSha256":"synthetic","pdfPage":2,"coordinate":151.0}'
    const pages = `{"source":${source},"text":"First line\\nSecond 合成行 \\n","method":"synthetic"}\n`
    const original = `{"id":"m1","code":"A","source":${source.slice(0, -1)},"nativeTextLine":0,"rawLine":"First line"},"adrgCode":"AA1","runtimeEnabled":false}\n`
      + `{"id":"m2","code":"A","source":${source.slice(0, -1)},"nativeTextLine":1,"rawLine":"Second 合成行 "},"adrgCode":"AA2","runtimeEnabled":false}\n`
    const input = fixture({ 'drg/rule-members.jsonl': original, 'drg/native-page-text.jsonl': pages })
    const result = await buildNormalizedArtifacts({ packages: [inputPackage], storageRoot: '.data/compact', read: input.read })
    for (const [path, bytes] of result.artifacts) input.source.set(path, bytes)
    const recipe = result.recipes.get(`${packageRoot}/drg/rule-members.jsonl`)!
    expect(await renderNormalizedRecipe(recipe, input.read)).toEqual(Buffer.from(original))
    expect([...result.artifacts.values()].map(bytes => bytes.toString('utf8')).join('')).not.toContain('archiveSha256')
  })

  it('rejects member provenance that differs from the retained original PDF page', async () => {
    const input = fixture({
      'drg/native-page-text.jsonl': '{"source":{"pdfPage":2,"origin":"original"},"text":"source line\\n"}\n',
      'drg/rule-members.jsonl': '{"id":"m1","source":{"pdfPage":2,"origin":"changed","nativeTextLine":0,"rawLine":"source line"}}\n',
    })
    await expect(buildNormalizedArtifacts({ packages: [inputPackage], storageRoot: '.data/compact', read: input.read }))
      .rejects.toThrow('not byte-identical')
  })

  it('rejects missing native pages and out-of-range line references', async () => {
    const input = fixture({
      'drg/native-page-text.jsonl': '{"source":{"pdfPage":2},"text":"source line\\n"}\n',
      'drg/rule-members.jsonl': '{"id":"m1","source":{"pdfPage":2,"nativeTextLine":1,"rawLine":"source line"}}\n',
    })
    await expect(buildNormalizedArtifacts({ packages: [inputPackage], storageRoot: '.data/compact', read: input.read }))
      .rejects.toThrow('zero-based line')
    input.source.set(`${packageRoot}/drg/rule-members.jsonl`, Buffer.from('{"id":"m1","source":{"pdfPage":3,"nativeTextLine":0,"rawLine":"source line"}}\n'))
    await expect(buildNormalizedArtifacts({ packages: [inputPackage], storageRoot: '.data/compact', read: input.read }))
      .rejects.toThrow('missing native PDF page')
  })

  it('rejects corrupt template references without yielding a plausible readiness record', async () => {
    const input = fixture({ 'assessment/record-readiness.jsonl': '{"id":"r1","runtimeEnabled":false}\n' })
    const result = await buildNormalizedArtifacts({ packages: [inputPackage], storageRoot: '.data/compact', read: input.read })
    for (const [path, bytes] of result.artifacts) input.source.set(path, bytes)
    const recipe = result.recipes.get(`${packageRoot}/assessment/record-readiness.jsonl`)!
    input.source.set(recipe.dataPath, Buffer.from('[200,"r1"]\n'))
    await expect(renderNormalizedRecipe(recipe, input.read)).rejects.toThrow('template reference')
    input.source.set(recipe.dataPath, Buffer.from('[0,"r1","unexpected"]\n'))
    await expect(renderNormalizedRecipe(recipe, input.read)).rejects.toThrow('arity mismatch')
  })

  it('rejects repeated JSON properties that cannot be represented as unambiguous facts', async () => {
    const input = fixture({ 'assessment/record-readiness.jsonl': '{"id":"r1","id":"r2","runtimeEnabled":false}\n' })
    await expect(buildNormalizedArtifacts({ packages: [inputPackage], storageRoot: '.data/compact', read: input.read }))
      .rejects.toThrow('Duplicate normalized JSON property')
  })
})
