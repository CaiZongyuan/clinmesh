import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  parseLoincCsvReferenceArtifact,
  parseUcumXmlReferenceArtifact,
} from '../src/infrastructure/reference-data/reference-source-importers.ts'

const fixture = (name: string) => fileURLToPath(
  new URL(`./fixtures/reference-data/${name}`, import.meta.url),
)

describe('LOINC and UCUM source importers', () => {
  it('converts the synthetic LOINC 2.83 CSV shape into strict reference concepts', async () => {
    const artifact = parseLoincCsvReferenceArtifact({
      content: await readFile(fixture('synthetic-loinc-2.83-shape.csv'), 'utf8'),
      version: '2.83',
    })

    expect(artifact.schemaVersion).toBe('1')
    expect(artifact.concepts[0]).toEqual({
      code: '90001-1',
      display: 'Synthetic laboratory concept alpha',
      domain: 'laboratory',
      id: 'loinc:2.83:90001-1',
      sourceLocator: 'LoincTableCore.csv:2',
      status: 'active',
      system: 'http://loinc.org',
      version: '2.83',
    })
    expect(artifact.concepts.map(concept => concept.code)).toEqual([
      '90001-1',
      '90002-2',
      '90003-3',
    ])
  })

  it('converts the synthetic UCUM 2.2 XML shape without treating display as code', async () => {
    const artifact = parseUcumXmlReferenceArtifact({
      content: await readFile(fixture('synthetic-ucum-2.2-shape.xml'), 'utf8'),
      version: '2.2',
    })

    expect(artifact.concepts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: '{clinmesh_synthetic_a}',
        display: 'synthetic-a',
        domain: 'unit',
        id: 'ucum:2.2:{clinmesh_synthetic_a}',
        sourceLocator: 'ucum-essence.xml:unit[1]',
        system: 'http://unitsofmeasure.org',
        version: '2.2',
      }),
      expect.objectContaining({ code: '{clinmesh_synthetic_b}', display: 'synthetic-b' }),
      expect.objectContaining({ code: '{clinmesh_synthetic_c}', display: 'synthetic-c' }),
    ]))
    expect(artifact.concepts).toHaveLength(3)
  })

  it('rejects malformed rows and duplicate source coding', () => {
    expect(() => parseLoincCsvReferenceArtifact({
      content: 'LOINC_NUM,LONG_COMMON_NAME\n8310-5,Body temperature\n',
      version: '2.83',
    })).toThrow()
    expect(() => parseLoincCsvReferenceArtifact({
      content: 'LOINC_NUM,LONG_COMMON_NAME,STATUS\n8310-5,Body temperature,ACTIVE\n8310-5,Other,ACTIVE\n',
      version: '2.83',
    })).toThrow('repeated')
  })
})
