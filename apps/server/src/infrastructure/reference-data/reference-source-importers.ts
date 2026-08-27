import {
  referenceArtifactSchema,
  referenceCodingIdentity,
  type ReferenceArtifact,
} from '@clinmesh/contracts/reference-data'
import { parse } from 'csv-parse/sync'
import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'

const loincVersionSchema = z.literal('2.83')
const ucumVersionSchema = z.literal('2.2')

const loincRecordSchema = z.object({
  record: z.object({
    LONG_COMMON_NAME: z.string().trim().min(1),
    LOINC_NUM: z.string().regex(/^\d{1,5}-\d$/),
    STATUS: z.enum(['ACTIVE', 'DEPRECATED', 'DISCOURAGED', 'TRIAL']),
  }).passthrough(),
  info: z.object({ lines: z.number().int().positive() }).passthrough(),
}).passthrough()

const ucumDocumentSchema = z.object({
  root: z.object({
    unit: z.array(z.object({
      Code: z.string().min(1),
      name: z.string().min(1),
      printSymbol: z.string().min(1),
    }).passthrough()),
    version: ucumVersionSchema,
  }).passthrough(),
}).passthrough()

function assertUniqueCodes(artifact: ReferenceArtifact): ReferenceArtifact {
  const codes = new Set<string>()
  for (const concept of artifact.concepts) {
    const key = referenceCodingIdentity(concept)
    if (codes.has(key)) throw new Error(`Reference source coding was repeated: ${concept.code}`)
    codes.add(key)
  }
  return artifact
}

export function parseLoincCsvReferenceArtifact(input: {
  content: string
  version: string
}): ReferenceArtifact {
  const version = loincVersionSchema.parse(input.version)
  const rows = z.array(loincRecordSchema).parse(parse(input.content, {
    bom: true,
    columns: true,
    info: true,
    skip_empty_lines: true,
  }))
  return assertUniqueCodes(referenceArtifactSchema.parse({
    concepts: rows.map(({ info, record }) => ({
      code: record.LOINC_NUM,
      display: record.LONG_COMMON_NAME,
      domain: 'laboratory',
      id: `loinc:${version}:${record.LOINC_NUM}`,
      sourceLocator: `LoincTableCore.csv:${info.lines}`,
      status: record.STATUS === 'ACTIVE' ? 'active' : 'inactive',
      system: 'http://loinc.org',
      version,
    })),
    schemaVersion: '1',
  }))
}

export function parseUcumXmlReferenceArtifact(input: {
  content: string
  version: string
}): ReferenceArtifact {
  const version = ucumVersionSchema.parse(input.version)
  const parsed = ucumDocumentSchema.parse(new XMLParser({
    attributeNamePrefix: '',
    ignoreAttributes: false,
    isArray: (_name, path) => path === 'root.unit',
    parseTagValue: false,
    trimValues: true,
  }).parse(input.content))
  return assertUniqueCodes(referenceArtifactSchema.parse({
    concepts: parsed.root.unit.map((unit, index) => ({
      code: unit.Code,
      display: unit.printSymbol,
      domain: 'unit',
      id: `ucum:${version}:${unit.Code}`,
      sourceLocator: `ucum-essence.xml:unit[${index + 1}]`,
      status: 'active',
      system: 'http://unitsofmeasure.org',
      version,
    })),
    schemaVersion: '1',
  }))
}
