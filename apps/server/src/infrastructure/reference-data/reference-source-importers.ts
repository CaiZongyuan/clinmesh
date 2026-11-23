import { closeSync, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import {
  referenceCodingIdentity,
  referenceConceptSchema,
  referenceLaboratoryDefinitionSchema,
  referenceLaboratoryPanelMemberSchema,
  referenceLaboratorySpecimenSchema,
  referenceLaboratoryUnitSchema,
  referenceMedicalServiceSchema,
  referenceMedicationProductSchema,
  referenceValueSetEntrySchema,
  type ReferenceArtifact,
  type ReferenceArtifactFormat,
  type ReferenceConcept,
  type ReferenceLaboratoryDefinition,
  type ReferenceLaboratoryPanelMember,
  type ReferenceLaboratorySpecimen,
  type ReferenceLaboratoryUnit,
  type ReferenceMedicalService,
  type ReferenceMedicationProduct,
  type ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'
import { Parser } from 'csv-parse'
import { parse } from 'csv-parse/sync'
import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'

export type TextReferenceArtifactFormat = Exclude<ReferenceArtifactFormat, 'cn-health-candidate'>

export interface ReferenceStagingSink {
  flush: () => void
  stageConcept: (concept: ReferenceConcept) => void
  stageLaboratoryDefinition: (definition: ReferenceLaboratoryDefinition) => void
  stageLaboratoryPanelMember: (member: ReferenceLaboratoryPanelMember) => void
  stageLaboratorySpecimen: (specimen: ReferenceLaboratorySpecimen) => void
  stageLaboratoryUnit: (unit: ReferenceLaboratoryUnit) => void
  stageMedicalService: (service: ReferenceMedicalService) => void
  stageMedicationProduct: (product: ReferenceMedicationProduct) => void
  stageValueSetEntry: (entry: ReferenceValueSetEntry) => void
}

const fileStreamChunkBytes = 64 * 1024
const loincVersionSchema = z.literal('2.83')
const nhsaDiagnosisVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
const ucumVersionSchema = z.literal('2.2')

const loincRecordSchema = z.object({
  record: z.object({
    LONG_COMMON_NAME: z.string().trim().min(1),
    LOINC_NUM: z.string().regex(/^\d{1,6}-\d$/),
    STATUS: z.enum(['ACTIVE', 'DEPRECATED', 'DISCOURAGED', 'TRIAL']),
  }).passthrough(),
  info: z.object({ lines: z.number().int().positive() }).passthrough(),
}).passthrough()

const ucumUnitSchema = z.object({
  Code: z.string().min(1),
  name: z.string().min(1),
  printSymbol: z.string().min(1),
}).passthrough()

const ucumRootHeaderSchema = z.object({
  root: z.object({
    version: ucumVersionSchema,
  }).passthrough(),
}).passthrough()

const ucumSingleUnitElementSchema = z.object({
  unit: ucumUnitSchema,
}).passthrough()

const ucumDocumentSchema = z.object({
  root: z.object({
    unit: z.array(ucumUnitSchema),
    version: ucumVersionSchema,
  }).passthrough(),
}).passthrough()

const nhsaDiagnosisRecordSchema = z.object({
  record: z.object({
    NHSA_DIAGNOSIS_CODE: z.string().trim().min(1).max(64),
    NHSA_DIAGNOSIS_NAME: z.string().trim().min(1).max(500),
    STATUS: z.enum(['ACTIVE', 'INACTIVE']),
  }).passthrough(),
  info: z.object({ lines: z.number().int().positive() }).passthrough(),
}).passthrough()

const nhsaMedicationProductRecordSchema = z.object({
  record: z.object({
    APPROVAL_NUMBER: z.string().trim().min(1).max(256),
    BRAND_NAME: z.string().transform(value => value.trim() === '' ? null : value.trim()),
    DOSAGE_FORM: z.string().trim().min(1).max(256),
    GENERIC_NAME: z.string().trim().min(1).max(500),
    MANUFACTURER: z.string().trim().min(1).max(500),
    NHSA_PRODUCT_CODE: z.string().trim().min(1).max(256),
    PACKAGE_DESCRIPTION: z.string().trim().min(1).max(500),
    STATUS: z.enum(['ACTIVE', 'INACTIVE']),
    STRENGTH: z.string().trim().min(1).max(256),
  }).passthrough(),
  info: z.object({ lines: z.number().int().positive() }).passthrough(),
}).passthrough()

const nhcMedicalServiceRecordSchema = z.object({
  record: z.object({
    BILLING_UNIT_CODE: z.string().trim().min(1).max(128),
    CATEGORY_CODE: z.string().trim().min(1).max(128),
    SERVICE_CODE: z.string().trim().min(1).max(256),
    SERVICE_NAME: z.string().trim().min(1).max(1_000),
    STATUS: z.enum(['ACTIVE', 'INACTIVE']),
  }).passthrough(),
  info: z.object({ lines: z.number().int().positive() }).passthrough(),
}).passthrough()

const wstValueSetRecordSchema = z.object({
  record: z.object({
    CODE: z.string().trim().min(1).max(128),
    DISPLAY: z.string().trim().min(1).max(500),
    STATUS: z.enum(['ACTIVE', 'INACTIVE']),
    SYSTEM: z.string().url(),
    VALUE_SET_URI: z.string().url(),
  }).passthrough(),
  info: z.object({ lines: z.number().int().positive() }).passthrough(),
}).passthrough()

const clinmeshJsonAllowedKeys = new Set([
  'concepts',
  'laboratoryDefinitions',
  'laboratoryPanelMembers',
  'laboratorySpecimens',
  'laboratoryUnits',
  'medicationProducts',
  'schemaVersion',
  'services',
  'valueSetEntries',
])

const clinmeshSchemaVersionSchema = z.literal('1')

function mapLoincRecord(
  entry: z.infer<typeof loincRecordSchema>,
  version: string,
): ReferenceConcept {
  return referenceConceptSchema.parse({
    code: entry.record.LOINC_NUM,
    display: entry.record.LONG_COMMON_NAME,
    domain: 'laboratory',
    id: `loinc:${version}:${entry.record.LOINC_NUM}`,
    sourceLocator: `LoincTableCore.csv:${entry.info.lines}`,
    status: entry.record.STATUS === 'ACTIVE' ? 'active' : 'inactive',
    system: 'http://loinc.org',
    version,
  })
}

function mapNhsaDiagnosisRecord(
  entry: z.infer<typeof nhsaDiagnosisRecordSchema>,
  version: string,
): ReferenceConcept {
  return referenceConceptSchema.parse({
    code: entry.record.NHSA_DIAGNOSIS_CODE,
    display: entry.record.NHSA_DIAGNOSIS_NAME,
    domain: 'diagnosis',
    id: `nhsa-diagnosis:${version}:${entry.record.NHSA_DIAGNOSIS_CODE}`,
    sourceLocator: `nhsa-diagnosis.csv:${entry.info.lines}`,
    status: entry.record.STATUS === 'ACTIVE' ? 'active' : 'inactive',
    system: 'urn:clinmesh:reference:nhsa-diagnosis',
    version,
  })
}

function mapNhsaMedicationProductRecord(
  entry: z.infer<typeof nhsaMedicationProductRecordSchema>,
  version: string,
): ReferenceMedicationProduct {
  return referenceMedicationProductSchema.parse({
    approvalNumber: entry.record.APPROVAL_NUMBER,
    brandName: entry.record.BRAND_NAME,
    code: entry.record.NHSA_PRODUCT_CODE,
    dosageForm: entry.record.DOSAGE_FORM,
    genericName: entry.record.GENERIC_NAME,
    id: `nhsa-medication-product:${version}:${entry.record.NHSA_PRODUCT_CODE}`,
    manufacturer: entry.record.MANUFACTURER,
    packageDescription: entry.record.PACKAGE_DESCRIPTION,
    sourceLocator: `nhsa-medication-products.csv:${entry.info.lines}`,
    status: entry.record.STATUS === 'ACTIVE' ? 'active' : 'inactive',
    strength: entry.record.STRENGTH,
    system: 'urn:clinmesh:reference:nhsa-medication-product',
    version,
  })
}

function mapNhcMedicalServiceRecord(
  entry: z.infer<typeof nhcMedicalServiceRecordSchema>,
  version: string,
): ReferenceMedicalService {
  return referenceMedicalServiceSchema.parse({
    billingUnitCode: entry.record.BILLING_UNIT_CODE,
    categoryCode: entry.record.CATEGORY_CODE,
    code: entry.record.SERVICE_CODE,
    display: entry.record.SERVICE_NAME,
    id: `nhc-medical-service:${version}:${entry.record.SERVICE_CODE}`,
    sourceLocator: `nhc-medical-services.csv:${entry.info.lines}`,
    status: entry.record.STATUS === 'ACTIVE' ? 'active' : 'inactive',
    system: 'urn:clinmesh:reference:nhc-medical-service',
    version,
  })
}

function mapWstValueSetRecord(
  entry: z.infer<typeof wstValueSetRecordSchema>,
  version: string,
): ReferenceValueSetEntry {
  return referenceValueSetEntrySchema.parse({
    code: entry.record.CODE,
    display: entry.record.DISPLAY,
    id: `wst-value-set:${version}:${entry.record.VALUE_SET_URI}:${entry.record.CODE}`,
    sourceLocator: `wst-value-set.csv:${entry.info.lines}`,
    status: entry.record.STATUS === 'ACTIVE' ? 'active' : 'inactive',
    system: entry.record.SYSTEM,
    valueSet: entry.record.VALUE_SET_URI,
    version,
  })
}

function mapUcumUnit(
  unit: z.infer<typeof ucumUnitSchema>,
  index: number,
  version: string,
): ReferenceConcept {
  return referenceConceptSchema.parse({
    code: unit.Code,
    display: unit.printSymbol,
    domain: 'unit',
    id: `ucum:${version}:${unit.Code}`,
    sourceLocator: `ucum-essence.xml:unit[${index + 1}]`,
    status: 'active',
    system: 'http://unitsofmeasure.org',
    version,
  })
}

function buildReferenceArtifact(
  partial: Partial<Omit<ReferenceArtifact, 'schemaVersion'>>,
): ReferenceArtifact {
  return {
    concepts: partial.concepts ?? [],
    laboratoryDefinitions: partial.laboratoryDefinitions ?? [],
    laboratoryPanelMembers: partial.laboratoryPanelMembers ?? [],
    laboratorySpecimens: partial.laboratorySpecimens ?? [],
    laboratoryUnits: partial.laboratoryUnits ?? [],
    medicationProducts: partial.medicationProducts ?? [],
    schemaVersion: '1',
    services: partial.services ?? [],
    valueSetEntries: partial.valueSetEntries ?? [],
  }
}

function assertUniqueCodes(artifact: ReferenceArtifact): ReferenceArtifact {
  const codes = new Set<string>()
  for (const concept of artifact.concepts) {
    const key = referenceCodingIdentity(concept)
    if (codes.has(key)) throw new Error(`Reference source coding was repeated: ${concept.code}`)
    codes.add(key)
  }
  return artifact
}

function streamCsvRecords(artifactPath: string, onRecord: (rawRecord: unknown) => void): void {
  const parser = new Parser({
    bom: true,
    columns: true,
    info: true,
    skip_empty_lines: true,
  })
  let parseError: unknown
  parser.on('error', (error) => {
    parseError = error
  })
  const drain = () => {
    if (parseError !== undefined) throw parseError
    let record: unknown
    while ((record = parser.read()) !== null) {
      onRecord(record)
    }
    if (parseError !== undefined) throw parseError
  }
  const descriptor = openSync(artifactPath, 'r')
  const readBuffer = Buffer.allocUnsafe(fileStreamChunkBytes)
  try {
    let bytesRead: number
    while ((bytesRead = readSync(descriptor, readBuffer, 0, readBuffer.length, null)) > 0) {
      parser.write(Buffer.from(readBuffer.subarray(0, bytesRead)))
      drain()
    }
    parser.end()
    drain()
  } finally {
    closeSync(descriptor)
    parser.removeAllListeners()
  }
}

function stageCsvArtifact<ParsedRecord>(input: {
  artifactPath: string
  recordSchema: z.ZodType<ParsedRecord>
  sink: ReferenceStagingSink
  stageRow: (record: ParsedRecord) => void
}): { acceptedCount: number; recordCount: number } {
  let count = 0
  streamCsvRecords(input.artifactPath, (rawRecord) => {
    input.stageRow(input.recordSchema.parse(rawRecord))
    count += 1
  })
  input.sink.flush()
  return { acceptedCount: count, recordCount: count }
}

function streamUcumXmlUnits(
  artifactPath: string,
  version: string,
  sink: ReferenceStagingSink,
): { acceptedCount: number; recordCount: number } {
  const xmlElementParser = new XMLParser({
    attributeNamePrefix: '',
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: true,
  })
  const descriptor = openSync(artifactPath, 'r')
  const decoder = new StringDecoder('utf8')
  const readBuffer = Buffer.allocUnsafe(fileStreamChunkBytes)
  let buffer = ''
  let checkedRoot = false
  let firstChunk = true
  let unitCount = 0

  const stripLeadingPrologAndComments = (isFinal: boolean): boolean => {
    while (true) {
      buffer = buffer.trimStart()
      if (buffer.startsWith('<?')) {
        const end = buffer.indexOf('?>')
        if (end === -1) {
          if (isFinal) throw new Error('Malformed XML processing instruction in UCUM source')
          return false
        }
        buffer = buffer.slice(end + 2)
        continue
      }
      if (buffer.startsWith('<!--')) {
        const end = buffer.indexOf('-->')
        if (end === -1) {
          if (isFinal) throw new Error('Unclosed XML comment in UCUM source')
          return false
        }
        buffer = buffer.slice(end + 3)
        continue
      }
      return true
    }
  }

  const processAvailable = (isFinal: boolean): void => {
    if (!checkedRoot) {
      if (!stripLeadingPrologAndComments(isFinal)) return
      const rootMatch = /^<root(?:\s[^>]*?)?>/.exec(buffer)
      if (rootMatch === null) {
        if (isFinal || buffer.length > fileStreamChunkBytes) {
          throw new Error('UCUM XML root element is missing or invalid')
        }
        return
      }
      const rootOpeningTag = rootMatch[0]
      if (rootOpeningTag.endsWith('/>')) {
        throw new Error('UCUM XML root element must contain unit records')
      }
      ucumRootHeaderSchema.parse(xmlElementParser.parse(`${rootOpeningTag}</root>`))
      buffer = buffer.slice(rootOpeningTag.length)
      checkedRoot = true
    }

    while (true) {
      if (!stripLeadingPrologAndComments(isFinal)) return
      if (buffer.startsWith('<unit') && (buffer.length === 5 || /[\s/>]/.test(buffer[5]!))) {
        const openEnd = buffer.indexOf('>')
        if (openEnd === -1) {
          if (isFinal) throw new Error('Unclosed <unit> tag in UCUM source')
          return
        }
        let unitXml: string
        if (buffer[openEnd - 1] === '/') {
          unitXml = buffer.slice(0, openEnd + 1)
          buffer = buffer.slice(openEnd + 1)
        } else {
          const closeIndex = buffer.indexOf('</unit>', openEnd + 1)
          if (closeIndex === -1) {
            if (isFinal) throw new Error('Unclosed </unit> element in UCUM source')
            return
          }
          unitXml = buffer.slice(0, closeIndex + '</unit>'.length)
          buffer = buffer.slice(closeIndex + '</unit>'.length)
        }
        const parsedUnit = ucumSingleUnitElementSchema.parse(xmlElementParser.parse(unitXml))
        sink.stageConcept(mapUcumUnit(parsedUnit.unit, unitCount, version))
        unitCount += 1
        continue
      }
      break
    }
  }

  try {
    let bytesRead: number
    while ((bytesRead = readSync(descriptor, readBuffer, 0, readBuffer.length, null)) > 0) {
      let decoded = decoder.write(readBuffer.subarray(0, bytesRead))
      if (firstChunk) {
        firstChunk = false
        if (decoded.startsWith('\uFEFF')) decoded = decoded.slice(1)
      }
      buffer += decoded
      processAvailable(false)
    }
    buffer += decoder.end()
    processAvailable(true)
    if (!checkedRoot || unitCount === 0 || buffer.trim() !== '</root>') {
      throw new Error('UCUM XML document structure is invalid')
    }
  } finally {
    closeSync(descriptor)
  }

  sink.flush()
  return { acceptedCount: unitCount, recordCount: unitCount }
}

class StreamingJsonFileScanner {
  #buffer = ''
  readonly #decoder = new StringDecoder('utf8')
  readonly #descriptor: number
  #eof = false
  #firstChunk = true
  #position = 0
  readonly #readBuffer = Buffer.allocUnsafe(fileStreamChunkBytes)

  constructor(path: string) {
    this.#descriptor = openSync(path, 'r')
  }

  close(): void {
    closeSync(this.#descriptor)
  }

  #fill(): boolean {
    if (this.#eof) return false
    if (this.#position > 0) {
      this.#buffer = this.#buffer.slice(this.#position)
      this.#position = 0
    }
    const bytesRead = readSync(this.#descriptor, this.#readBuffer, 0, this.#readBuffer.length, null)
    if (bytesRead <= 0) {
      const tail = this.#decoder.end()
      this.#eof = true
      if (tail.length > 0) {
        this.#buffer += tail
        return true
      }
      return false
    }
    let chunk = this.#decoder.write(this.#readBuffer.subarray(0, bytesRead))
    if (this.#firstChunk) {
      this.#firstChunk = false
      if (chunk.startsWith('\uFEFF')) chunk = chunk.slice(1)
    }
    this.#buffer += chunk
    return true
  }

  #ensureChar(): boolean {
    while (this.#position >= this.#buffer.length) {
      if (!this.#fill()) return false
    }
    return true
  }

  skipWhitespace(): void {
    while (this.#ensureChar()) {
      const code = this.#buffer.charCodeAt(this.#position)
      if (code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D) {
        this.#position += 1
      } else {
        return
      }
    }
  }

  peekChar(): string | undefined {
    this.skipWhitespace()
    return this.#ensureChar() ? this.#buffer[this.#position] : undefined
  }

  expectChar(expected: string): void {
    const actual = this.peekChar()
    if (actual !== expected) {
      throw new SyntaxError(`Expected '${expected}' in clinmesh-reference-v1 JSON`)
    }
    this.#position += 1
  }

  assertEof(): void {
    if (this.peekChar() !== undefined) {
      throw new SyntaxError('Unexpected trailing content in clinmesh-reference-v1 JSON')
    }
  }

  #scanRawJsonToken(discard: boolean): string {
    this.skipWhitespace()
    if (!this.#ensureChar()) {
      throw new SyntaxError('Unexpected end of clinmesh-reference-v1 JSON')
    }
    if (this.#position > fileStreamChunkBytes) {
      this.#buffer = this.#buffer.slice(this.#position)
      this.#position = 0
    }
    const first = this.#buffer[this.#position]!
    if (first !== '{' && first !== '[' && first !== '"') {
      const start = this.#position
      while (true) {
        while (this.#position < this.#buffer.length) {
          const ch = this.#buffer[this.#position]!
          if (ch === ',' || ch === ']' || ch === '}' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
            return discard ? '' : this.#buffer.slice(start, this.#position)
          }
          this.#position += 1
        }
        const carry = discard ? '' : this.#buffer.slice(start, this.#position)
        this.#buffer = carry
        this.#position = carry.length
        if (!this.#fill()) {
          return discard ? '' : this.#buffer.slice(0, this.#position)
        }
      }
    }

    let depth = 0
    let inString = false
    let escaped = false
    const chunks: string[] = []
    let tokenStart = this.#position

    while (true) {
      while (this.#position < this.#buffer.length) {
        const ch = this.#buffer[this.#position]!
        this.#position += 1
        if (inString) {
          if (escaped) {
            escaped = false
          } else if (ch === '\\') {
            escaped = true
          } else if (ch === '"') {
            inString = false
            if (depth === 0) {
              if (discard) return ''
              chunks.push(this.#buffer.slice(tokenStart, this.#position))
              return chunks.join('')
            }
          }
          continue
        }
        if (ch === '"') {
          inString = true
        } else if (ch === '{' || ch === '[') {
          depth += 1
        } else if (ch === '}' || ch === ']') {
          depth -= 1
          if (depth < 0) {
            throw new SyntaxError('Mismatched closing bracket in clinmesh-reference-v1 JSON')
          }
          if (depth === 0) {
            if (discard) return ''
            chunks.push(this.#buffer.slice(tokenStart, this.#position))
            return chunks.join('')
          }
        }
      }
      if (!discard) {
        chunks.push(this.#buffer.slice(tokenStart, this.#position))
      }
      this.#buffer = ''
      this.#position = 0
      tokenStart = 0
      if (!this.#fill()) {
        throw new SyntaxError('Unterminated JSON structure in clinmesh-reference-v1 JSON')
      }
    }
  }

  readString(): string {
    const first = this.peekChar()
    if (first !== '"') {
      throw new SyntaxError('Expected JSON string key in clinmesh-reference-v1 JSON')
    }
    return z.string().parse(JSON.parse(this.#scanRawJsonToken(false)))
  }

  readValue(): unknown {
    return JSON.parse(this.#scanRawJsonToken(false))
  }

  streamArrayElements(onElement?: (element: unknown) => void): number {
    this.expectChar('[')
    if (this.peekChar() === ']') {
      this.#position += 1
      return 0
    }
    let elementCount = 0
    while (true) {
      if (onElement === undefined) {
        JSON.parse(this.#scanRawJsonToken(false))
      } else {
        onElement(this.readValue())
      }
      elementCount += 1
      const separator = this.peekChar()
      if (separator === ',') {
        this.#position += 1
        continue
      }
      if (separator === ']') {
        this.#position += 1
        return elementCount
      }
      throw new SyntaxError('Expected "," or "]" in clinmesh-reference-v1 JSON array')
    }
  }

  skipValue(): void {
    this.#scanRawJsonToken(true)
  }
}

function stageClinmeshJsonArtifact(
  artifactPath: string,
  sink: ReferenceStagingSink,
): { acceptedCount: number; recordCount: number } {
  let count = 0
  let hasSecondaryItems = false

  const firstPass = new StreamingJsonFileScanner(artifactPath)
  try {
    const seenKeys = new Set<string>()
    firstPass.expectChar('{')
    if (firstPass.peekChar() !== '}') {
      while (true) {
        const key = firstPass.readString()
        if (!clinmeshJsonAllowedKeys.has(key) || seenKeys.has(key)) {
          throw new Error(`Unsupported or duplicate clinmesh-reference-v1 property: ${key}`)
        }
        seenKeys.add(key)
        firstPass.expectChar(':')
        if (key === 'schemaVersion') {
          clinmeshSchemaVersionSchema.parse(firstPass.readValue())
        } else if (key === 'concepts') {
          firstPass.streamArrayElements((item) => {
            sink.stageConcept(referenceConceptSchema.parse(item))
            count += 1
          })
        } else {
          if (firstPass.streamArrayElements() > 0) {
            hasSecondaryItems = true
          }
        }
        const next = firstPass.peekChar()
        if (next === ',') {
          firstPass.expectChar(',')
          continue
        }
        if (next === '}') break
        throw new SyntaxError('Expected "," or "}" in clinmesh-reference-v1 JSON object')
      }
    }
    firstPass.expectChar('}')
    firstPass.assertEof()
    if (!seenKeys.has('schemaVersion') || !seenKeys.has('concepts')) {
      throw new Error('clinmesh-reference-v1 requires schemaVersion and concepts')
    }
  } finally {
    firstPass.close()
  }

  sink.flush()
  if (!hasSecondaryItems) {
    return { acceptedCount: count, recordCount: count }
  }

  const secondPass = new StreamingJsonFileScanner(artifactPath)
  try {
    secondPass.expectChar('{')
    while (secondPass.peekChar() !== '}') {
      const key = secondPass.readString()
      secondPass.expectChar(':')
      switch (key) {
        case 'laboratoryDefinitions':
          secondPass.streamArrayElements((item) => {
            const definition = referenceLaboratoryDefinitionSchema.parse(item)
            sink.stageLaboratoryDefinition(definition)
            if (definition.kind === 'laboratory-cn-test') {
              count += definition.adultReferenceRules.length
            }
          })
          break
        case 'laboratoryUnits':
          secondPass.streamArrayElements((item) => {
            sink.stageLaboratoryUnit(referenceLaboratoryUnitSchema.parse(item))
            count += 1
          })
          break
        case 'laboratorySpecimens':
          secondPass.streamArrayElements((item) => {
            sink.stageLaboratorySpecimen(referenceLaboratorySpecimenSchema.parse(item))
            count += 1
          })
          break
        case 'laboratoryPanelMembers':
          secondPass.streamArrayElements((item) => {
            sink.stageLaboratoryPanelMember(referenceLaboratoryPanelMemberSchema.parse(item))
            count += 1
          })
          break
        case 'medicationProducts':
          secondPass.streamArrayElements((item) => {
            sink.stageMedicationProduct(referenceMedicationProductSchema.parse(item))
            count += 1
          })
          break
        case 'services':
          secondPass.streamArrayElements((item) => {
            sink.stageMedicalService(referenceMedicalServiceSchema.parse(item))
            count += 1
          })
          break
        case 'valueSetEntries':
          secondPass.streamArrayElements((item) => {
            sink.stageValueSetEntry(referenceValueSetEntrySchema.parse(item))
            count += 1
          })
          break
        default:
          secondPass.skipValue()
          break
      }
      if (secondPass.peekChar() === ',') secondPass.expectChar(',')
    }
    secondPass.expectChar('}')
  } finally {
    secondPass.close()
  }

  sink.flush()
  return { acceptedCount: count, recordCount: count }
}

export function stageTextReferenceSourceArtifact(input: {
  artifactPath: string
  format: TextReferenceArtifactFormat
  sink: ReferenceStagingSink
  version: string
}): { acceptedCount: number; recordCount: number } {
  switch (input.format) {
    case 'loinc-csv': {
      const version = loincVersionSchema.parse(input.version)
      return stageCsvArtifact({
        artifactPath: input.artifactPath,
        recordSchema: loincRecordSchema,
        sink: input.sink,
        stageRow: record => input.sink.stageConcept(mapLoincRecord(record, version)),
      })
    }
    case 'nhsa-diagnosis-csv': {
      const version = nhsaDiagnosisVersionSchema.parse(input.version)
      return stageCsvArtifact({
        artifactPath: input.artifactPath,
        recordSchema: nhsaDiagnosisRecordSchema,
        sink: input.sink,
        stageRow: record => input.sink.stageConcept(mapNhsaDiagnosisRecord(record, version)),
      })
    }
    case 'nhsa-medication-product-csv': {
      const version = nhsaDiagnosisVersionSchema.parse(input.version)
      return stageCsvArtifact({
        artifactPath: input.artifactPath,
        recordSchema: nhsaMedicationProductRecordSchema,
        sink: input.sink,
        stageRow: record => input.sink.stageMedicationProduct(
          mapNhsaMedicationProductRecord(record, version),
        ),
      })
    }
    case 'nhc-medical-service-csv': {
      const version = nhsaDiagnosisVersionSchema.parse(input.version)
      return stageCsvArtifact({
        artifactPath: input.artifactPath,
        recordSchema: nhcMedicalServiceRecordSchema,
        sink: input.sink,
        stageRow: record => input.sink.stageMedicalService(
          mapNhcMedicalServiceRecord(record, version),
        ),
      })
    }
    case 'wst-value-set-csv': {
      const version = nhsaDiagnosisVersionSchema.parse(input.version)
      return stageCsvArtifact({
        artifactPath: input.artifactPath,
        recordSchema: wstValueSetRecordSchema,
        sink: input.sink,
        stageRow: record => input.sink.stageValueSetEntry(
          mapWstValueSetRecord(record, version),
        ),
      })
    }
    case 'ucum-xml': {
      const version = ucumVersionSchema.parse(input.version)
      return streamUcumXmlUnits(input.artifactPath, version, input.sink)
    }
    case 'clinmesh-reference-v1':
      return stageClinmeshJsonArtifact(input.artifactPath, input.sink)
  }
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
  return assertUniqueCodes(buildReferenceArtifact({
    concepts: rows.map(entry => mapLoincRecord(entry, version)),
  }))
}

export function parseNhsaDiagnosisCsvReferenceArtifact(input: {
  content: string
  version: string
}): ReferenceArtifact {
  const version = nhsaDiagnosisVersionSchema.parse(input.version)
  const rows = z.array(nhsaDiagnosisRecordSchema).parse(parse(input.content, {
    bom: true,
    columns: true,
    info: true,
    skip_empty_lines: true,
  }))
  return assertUniqueCodes(buildReferenceArtifact({
    concepts: rows.map(entry => mapNhsaDiagnosisRecord(entry, version)),
  }))
}

export function parseNhsaMedicationProductCsvArtifact(input: {
  content: string
  version: string
}): ReferenceArtifact {
  const version = nhsaDiagnosisVersionSchema.parse(input.version)
  const rows = z.array(nhsaMedicationProductRecordSchema).parse(parse(input.content, {
    bom: true,
    columns: true,
    info: true,
    skip_empty_lines: true,
  }))
  return buildReferenceArtifact({
    medicationProducts: rows.map(entry => mapNhsaMedicationProductRecord(entry, version)),
  })
}

export function parseNhcMedicalServiceCsvArtifact(input: {
  content: string
  version: string
}): ReferenceArtifact {
  const version = nhsaDiagnosisVersionSchema.parse(input.version)
  const rows = z.array(nhcMedicalServiceRecordSchema).parse(parse(input.content, {
    bom: true,
    columns: true,
    info: true,
    skip_empty_lines: true,
  }))
  return buildReferenceArtifact({
    services: rows.map(entry => mapNhcMedicalServiceRecord(entry, version)),
  })
}

export function parseWstValueSetCsvArtifact(input: {
  content: string
  version: string
}): ReferenceArtifact {
  const version = nhsaDiagnosisVersionSchema.parse(input.version)
  const rows = z.array(wstValueSetRecordSchema).parse(parse(input.content, {
    bom: true,
    columns: true,
    info: true,
    skip_empty_lines: true,
  }))
  return buildReferenceArtifact({
    valueSetEntries: rows.map(entry => mapWstValueSetRecord(entry, version)),
  })
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
  return assertUniqueCodes(buildReferenceArtifact({
    concepts: parsed.root.unit.map((unit, index) => mapUcumUnit(unit, index, version)),
  }))
}
