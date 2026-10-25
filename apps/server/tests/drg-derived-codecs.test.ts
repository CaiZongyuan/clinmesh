import { describe, expect, it } from 'vitest'
import type { OfflineReferenceLock } from '@clinmesh/contracts/reference-data'
import { buildDerivedRecipes, derivedRecipeSchema, renderDerivedRecipe } from '../src/infrastructure/reference-data/drg-derived-codecs.ts'

const prepared: OfflineReferenceLock['packages'][number] = {
  id: 'prepared-five-catalogues', format: 'prepared-catalogues-v1', root: 'prepared', version: 'synthetic-v1',
  manifest: { path: 'manifest.json', sha256: 'a'.repeat(64) }, sourceUrl: 'https://example.test/', quarantineReasons: [],
}
const openDrg: OfflineReferenceLock['packages'][number] = {
  id: 'opendrg-public-data', format: 'opendrg-public-data-v1', root: 'open', version: '2026-10-20',
  manifest: { path: 'manifest.json', sha256: 'a'.repeat(64) }, sourceUrl: 'https://example.test/', quarantineReasons: [],
  checksums: { path: 'checksums.json', sha256: 'b'.repeat(64) },
}

function fixture(root: string, values: Record<string, string>, index = 'manifest.json') {
  const files = new Map(Object.entries(values).map(([path, value]) => [`${root}/${path}`, Buffer.from(value)]))
  files.set(`${root}/${index}`, Buffer.from(JSON.stringify({ files: Object.keys(values).map(path => ({ path })) })))
  return {
    files,
    read: async (path: string) => {
      const value = files.get(path)
      if (value === undefined) throw new Error(`Missing fixture: ${path}`)
      return value
    },
  }
}

describe('DRG derived artifact codecs', () => {
  it('exports eligible records with their original line bytes and keeps ineligible source rows', async () => {
    const first = '{"id":"one","eligibleReferenceCandidate":true,"value":1.0}\r\n'
    const second = '{"id":"two","eligibleReferenceCandidate":false}\r\n'
    const input = fixture('prepared', {
      'icd10/records.jsonl': first + second,
      'icd10/accepted.jsonl': first,
    })
    const recipes = await buildDerivedRecipes({ packages: [prepared], read: input.read })
    expect([...recipes.keys()]).toEqual(['prepared/icd10/accepted.jsonl'])
    expect(await renderDerivedRecipe(recipes.get('prepared/icd10/accepted.jsonl')!, input.read)).toEqual(Buffer.from(first))
    expect(input.files.get('prepared/icd10/records.jsonl')).toEqual(Buffer.from(first + second))
  })

  it('reconstructs hierarchy in first-occurrence order without changing source number tokens', async () => {
    const source = '{"pdfPage":1,"pdfRowBounds":[151.0,193.0],"note":{"source":"nested"}}'
    const input = fixture('prepared', {
      'icd10/records.jsonl': `{"id":"r1","fields":{"chapter_code":"1","chapter_name":"合成章"},"source":${source}}\n`
        + '{"id":"r2","fields":{"chapter_code":"1","chapter_name":"合成章","category_code":"A","category_name":"合成类"},"source":{"pdfPage":2}}\n',
      'icd10/hierarchy.jsonl': `{"id":"icd10:chapter:1","level":"chapter","code":"1","name":"合成章","parentId":null,"source":${source},"occurrenceRecordIds":["r1","r2"],"variants":[],"reviewFlags":[]}\n`
        + '{"id":"icd10:category:A","level":"category","code":"A","name":"合成类","parentId":"icd10:chapter:1","source":{"pdfPage":2},"occurrenceRecordIds":["r2"],"variants":[],"reviewFlags":[]}\n',
    })
    const recipes = await buildDerivedRecipes({ packages: [prepared], read: input.read })
    expect(await renderDerivedRecipe(recipes.get('prepared/icd10/hierarchy.jsonl')!, input.read))
      .toEqual(input.files.get('prepared/icd10/hierarchy.jsonl'))
  })

  it('exports dataset CSV cells with BOM, quotes, empty rows and CRLF while replacing module copies', async () => {
    const input = fixture('open', {
      'catalog/datasets.json': '[{"jsonPath":"dictionaries/one.json","csvPath":"dictionaries/one.csv","moduleId":7},{"jsonPath":"dictionaries/empty.json","csvPath":"dictionaries/empty.csv"}]',
      'dictionaries/one.json': '[["a, b","a\\\"b",null,true,{"a":1}],[]]',
      'dictionaries/one.csv': '\uFEFF"a, b","a""b","","true","{""a"":1}"\r\n\r\n',
      'data/modules/7.json': '[\n  [\n    "a, b",\n    "a\\\"b",\n    null,\n    true,\n    {\n      "a": 1\n    }\n  ],\n  []\n]\n',
      'dictionaries/empty.json': '[]',
      'dictionaries/empty.csv': '\uFEFF\r\n',
    }, 'checksums.json')
    const recipes = await buildDerivedRecipes({ packages: [openDrg], read: input.read })
    expect(recipes.size).toBe(3)
    for (const [path, recipe] of recipes) expect(await renderDerivedRecipe(recipe, input.read)).toEqual(input.files.get(path))
  })

  it('exports grouper tables in source insertion order with their original headers', async () => {
    const input = fixture('open', {
      'catalog/groupers.json': '[{"jsonPath":"groupers/synthetic.json","exports":{"CC":{"csvPath":"groupers/synthetic/CC.csv"},"SS_VALID":{"csvPath":"groupers/synthetic/SS_VALID.csv"}}}]',
      'groupers/synthetic.json': '{"CC":{"B":"2","A":"1"},"SS_VALID":["02","01"]}',
      'groupers/synthetic/CC.csv': '\uFEFF"诊断编码","排除表编号"\r\n"B","2"\r\n"A","1"\r\n',
      'groupers/synthetic/SS_VALID.csv': '\uFEFF"手术编码"\r\n"02"\r\n"01"\r\n',
    }, 'checksums.json')
    const recipes = await buildDerivedRecipes({ packages: [openDrg], read: input.read })
    expect(recipes.size).toBe(2)
    for (const [path, recipe] of recipes) expect(await renderDerivedRecipe(recipe, input.read)).toEqual(input.files.get(path))
  })

  it('exports merged payments with source row numbers, source URLs and union column order', async () => {
    const input = fixture('open', {
      'catalog/datasets.json': '[{"jsonPath":"payments/one.json","category":"payments","name":"one.csv","sourceUrl":"https://example.test/one"},{"jsonPath":"payments/two.json","category":"payments","name":"two.csv","sourceUrl":"https://example.test/two"}]',
      'catalog/schemes.json': '[{"id":"one","label":"合成方案"}]',
      'payments/one.json': '[["code","weight"],["A",1],[null,""]]',
      'payments/two.json': '[["cost","code"],[5,"B"]]',
      'catalog/权重费用合并表.csv': '\uFEFF"来源表","方案显示名称","原始行号","来源URL","code","weight","cost"\r\n"one","合成方案","2","https://example.test/one","A","1",""\r\n"two","","2","https://example.test/two","B","","5"\r\n',
    }, 'checksums.json')
    const recipes = await buildDerivedRecipes({ packages: [openDrg], read: input.read })
    expect(recipes.size).toBe(1)
    expect(await renderDerivedRecipe(recipes.get('open/catalog/权重费用合并表.csv')!, input.read))
      .toEqual(input.files.get('open/catalog/权重费用合并表.csv'))
  })

  it('exports packed rules as inert text with normalized lines and one trailing LF', async () => {
    const input = fixture('open', {
      'catalog/rules.json': '[{"path":"synthetic/test.dat"}]',
      'rules/rule-dat-pack.json': '{"synthetic/test.dat":"throw new Error(\\\"never execute\\\")\\r\\nsecond\\n\\n"}',
      'rules/files/synthetic/test.dat': 'throw new Error("never execute")\nsecond\n',
    }, 'checksums.json')
    const recipes = await buildDerivedRecipes({ packages: [openDrg], read: input.read })
    expect(recipes.size).toBe(1)
    expect(await renderDerivedRecipe(recipes.get('open/rules/files/synthetic/test.dat')!, input.read))
      .toEqual(input.files.get('open/rules/files/synthetic/test.dat'))
  })

  it('rejects an incomplete or changed derivative rather than discarding unreconstructable facts', async () => {
    const input = fixture('prepared', {
      'icd10/records.jsonl': '{"id":"one","eligibleReferenceCandidate":true}\n',
      'icd10/accepted.jsonl': '{"id":"extra-fact","eligibleReferenceCandidate":true}\n',
    })
    await expect(buildDerivedRecipes({ packages: [prepared], read: input.read }))
      .rejects.toThrow('not byte-identical: prepared/icd10/accepted.jsonl')
  })

  it('only replaces indexed files and rejects unsafe or unrecognized persisted recipes', async () => {
    const input = fixture('prepared', { 'icd10/records.jsonl': '{"eligibleReferenceCandidate":true}\n' })
    input.files.set('prepared/icd10/accepted.jsonl', Buffer.from('{"eligibleReferenceCandidate":true}\n'))
    expect((await buildDerivedRecipes({ packages: [prepared], read: input.read })).size).toBe(0)
    for (const source of ['../outside', '/absolute', 'C:/outside', 'one\\two', 'one/../two']) {
      expect(derivedRecipeSchema.safeParse({ kind: 'accepted-jsonl', source }).success).toBe(false)
    }
    expect(derivedRecipeSchema.safeParse({ kind: 'execute-js', source: 'source.js' }).success).toBe(false)
    expect(derivedRecipeSchema.safeParse({ kind: 'accepted-jsonl', source: 'source.jsonl', executable: true }).success).toBe(false)
  })
})
