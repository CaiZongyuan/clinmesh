import {
  referenceArtifactSchema,
  referenceCodingIdentity,
  type ReferenceArtifact,
  type ReferenceArtifactFormat,
} from '@clinmesh/contracts/reference-data'
import { parse } from 'csv-parse/sync'
import { XMLParser } from 'fast-xml-parser'
import { z } from 'zod'

const loincVersionSchema = z.literal('2.83')
const nhsaDiagnosisVersionSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
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
  return assertUniqueCodes(referenceArtifactSchema.parse({
    concepts: rows.map(({ info, record }) => ({
      code: record.NHSA_DIAGNOSIS_CODE,
      display: record.NHSA_DIAGNOSIS_NAME,
      domain: 'diagnosis',
      id: `nhsa-diagnosis:${version}:${record.NHSA_DIAGNOSIS_CODE}`,
      sourceLocator: `nhsa-diagnosis.csv:${info.lines}`,
      status: record.STATUS === 'ACTIVE' ? 'active' : 'inactive',
      system: 'urn:clinmesh:reference:nhsa-diagnosis',
      version,
    })),
    schemaVersion: '1',
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
  return referenceArtifactSchema.parse({
    concepts: [],
    medicationProducts: rows.map(({ info, record }) => ({
      approvalNumber: record.APPROVAL_NUMBER,
      brandName: record.BRAND_NAME,
      code: record.NHSA_PRODUCT_CODE,
      dosageForm: record.DOSAGE_FORM,
      genericName: record.GENERIC_NAME,
      id: `nhsa-medication-product:${version}:${record.NHSA_PRODUCT_CODE}`,
      manufacturer: record.MANUFACTURER,
      packageDescription: record.PACKAGE_DESCRIPTION,
      sourceLocator: `nhsa-medication-products.csv:${info.lines}`,
      status: record.STATUS === 'ACTIVE' ? 'active' : 'inactive',
      strength: record.STRENGTH,
      system: 'urn:clinmesh:reference:nhsa-medication-product',
      version,
    })),
    schemaVersion: '1',
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
  return referenceArtifactSchema.parse({
    concepts: [],
    schemaVersion: '1',
    services: rows.map(({ info, record }) => ({
      billingUnitCode: record.BILLING_UNIT_CODE,
      categoryCode: record.CATEGORY_CODE,
      code: record.SERVICE_CODE,
      display: record.SERVICE_NAME,
      id: `nhc-medical-service:${version}:${record.SERVICE_CODE}`,
      sourceLocator: `nhc-medical-services.csv:${info.lines}`,
      status: record.STATUS === 'ACTIVE' ? 'active' : 'inactive',
      system: 'urn:clinmesh:reference:nhc-medical-service',
      version,
    })),
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
  return referenceArtifactSchema.parse({
    concepts: [],
    schemaVersion: '1',
    valueSetEntries: rows.map(({ info, record }) => ({
      code: record.CODE,
      display: record.DISPLAY,
      id: `wst-value-set:${version}:${record.VALUE_SET_URI}:${record.CODE}`,
      sourceLocator: `wst-value-set.csv:${info.lines}`,
      status: record.STATUS === 'ACTIVE' ? 'active' : 'inactive',
      system: record.SYSTEM,
      valueSet: record.VALUE_SET_URI,
      version,
    })),
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

export function parseReferenceSourceArtifact(input: {
  content: string
  format: ReferenceArtifactFormat
  version: string
}): ReferenceArtifact {
  switch (input.format) {
    case 'clinmesh-reference-v1':
      return referenceArtifactSchema.parse(JSON.parse(input.content))
    case 'loinc-csv':
      return parseLoincCsvReferenceArtifact(input)
    case 'nhsa-diagnosis-csv':
      return parseNhsaDiagnosisCsvReferenceArtifact(input)
    case 'nhsa-medication-product-csv':
      return parseNhsaMedicationProductCsvArtifact(input)
    case 'nhc-medical-service-csv':
      return parseNhcMedicalServiceCsvArtifact(input)
    case 'ucum-xml':
      return parseUcumXmlReferenceArtifact(input)
    case 'wst-value-set-csv':
      return parseWstValueSetCsvArtifact(input)
  }
}
