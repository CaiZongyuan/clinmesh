import {
  syntheticPatientIdentitySchema,
  syntheaCnLocalizationProvenanceSchema,
  type SyntheaCnLocalizationProvenance,
  type SyntheticPatientIdentity,
} from '@clinmesh/contracts/scenario'
import { z } from 'zod'
import { hasValidResidentIdChecksum } from './synthetic-resident-id.ts'

const syntheaCnProfileTagSystem = 'urn:cn-health-data:synthea-profile'

const chineseText = /[\u3400-\u9fff]/u
const allowedIdentifierSystems = new Set([
  'https://github.com/synthetichealth/synthea',
  'urn:cn-health-data:simulated-resident-id',
  'urn:cn-health-data:synthetic-mrn',
  'urn:cn-health-data:synthetic-person',
])

const bundleSchema = z.object({
  entry: z.array(z.object({
    resource: z.object({
      id: z.string().min(1),
      resourceType: z.string().min(1),
    }).passthrough(),
  }).passthrough()).min(1),
  meta: z.object({
    tag: z.array(z.object({
      code: z.string().min(1).optional(),
      display: z.string().min(1).optional(),
      system: z.string().min(1).optional(),
    }).passthrough()),
  }).passthrough(),
  resourceType: z.literal('Bundle'),
  type: z.literal('collection'),
}).passthrough()

const patientSchema = z.object({
  address: z.array(z.object({
    city: z.string().min(1),
    country: z.literal('CN'),
    line: z.array(z.string().min(1)).min(1),
    postalCode: z.string().regex(/^\d{6}$/),
    state: z.string().min(1),
    use: z.string().optional(),
  }).passthrough()).min(1),
  birthDate: z.iso.date(),
  id: z.string().min(1),
  identifier: z.array(z.object({
    extension: z.array(z.object({
      url: z.string().min(1),
      valueBoolean: z.boolean().optional(),
    }).passthrough()).optional(),
    system: z.string().min(1),
    value: z.string().min(1),
  }).passthrough()).min(4),
  name: z.array(z.object({
    family: z.string().min(1),
    given: z.array(z.string().min(1)).min(1),
    text: z.string().min(1),
    use: z.string().optional(),
  }).passthrough()).min(1),
  resourceType: z.literal('Patient'),
  telecom: z.array(z.object({
    system: z.enum(['email', 'phone']),
    value: z.string().min(1),
  }).passthrough()).length(2),
}).passthrough()

export class SyntheaLocalizationValidationError extends Error {
  constructor(options?: ErrorOptions) {
    super('Synthea localization provenance or Patient identity is invalid', options)
    this.name = 'SyntheaLocalizationValidationError'
  }
}

function fail(cause?: unknown): never {
  throw new SyntheaLocalizationValidationError(cause === undefined ? undefined : { cause })
}

function requiredIdentifier(
  patient: z.infer<typeof patientSchema>,
  system: string,
): z.infer<typeof patientSchema>['identifier'][number] {
  const matches = patient.identifier.filter(identifier => identifier.system === system)
  if (matches.length !== 1) fail()
  return matches[0]!
}

function validResidentId(value: string, birthDate: string): boolean {
  if (!/^990000\d{11}[\dX]$/.test(value)) return false
  if (value.slice(6, 14) !== birthDate.replaceAll('-', '')) return false
  return hasValidResidentIdChecksum(value)
}

export function localizedSyntheaPatientIdentity(input: {
  bundle: unknown
  expectedPatientId?: string
  provenance: unknown
}): {
  identity: SyntheticPatientIdentity
  provenance: SyntheaCnLocalizationProvenance
} {
  const provenanceResult = syntheaCnLocalizationProvenanceSchema.safeParse(input.provenance)
  const bundleResult = bundleSchema.safeParse(input.bundle)
  if (!provenanceResult.success || !bundleResult.success) {
    fail(!provenanceResult.success ? provenanceResult.error : bundleResult.error)
  }
  const provenance = provenanceResult.data
  const bundle = bundleResult.data
  const tags = bundle.meta.tag.filter(tag => tag.system === syntheaCnProfileTagSystem)
  if (
    tags.length !== 1
    || tags[0]?.code !== provenance.profileId
    || tags[0]?.display !== provenance.profileContentHash
  ) fail()

  const patientEntries = bundle.entry.filter(entry => entry.resource.resourceType === 'Patient')
  if (patientEntries.length !== 1) fail()
  const patientResult = patientSchema.safeParse(patientEntries[0]?.resource)
  if (!patientResult.success) fail(patientResult.error)
  const patient = patientResult.data
  if (
    input.expectedPatientId !== undefined
    && input.expectedPatientId !== `synthea-patient-${patient.id}`
  ) fail()

  const name = patient.name.find(candidate => candidate.use === 'official') ?? patient.name[0]!
  const address = patient.address.find(candidate => candidate.use === 'home') ?? patient.address[0]!
  if (
    !chineseText.test(name.text)
    || !chineseText.test(address.state)
    || !chineseText.test(address.city)
    || !address.line[0]!.includes('合成')
    || patient.identifier.some(identifier => !allowedIdentifierSystems.has(identifier.system))
  ) fail()

  const syntheticPerson = requiredIdentifier(patient, 'urn:cn-health-data:synthetic-person')
  const mrn = requiredIdentifier(patient, 'urn:cn-health-data:synthetic-mrn')
  const residentId = requiredIdentifier(patient, 'urn:cn-health-data:simulated-resident-id')
  requiredIdentifier(patient, 'https://github.com/synthetichealth/synthea')
  if (
    !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(syntheticPerson.value)
    || !/^CNH[0-9A-F]{12}$/.test(mrn.value)
    || !validResidentId(residentId.value, patient.birthDate)
    || !residentId.extension?.some(extension => (
      extension.url === 'urn:cn-health-data:synthetic' && extension.valueBoolean === true
    ))
  ) fail()

  const phone = patient.telecom.find(contact => contact.system === 'phone')?.value
  const email = patient.telecom.find(contact => contact.system === 'email')?.value
  if (phone === undefined || !/^100\d{8}$/.test(phone) || !email?.endsWith('@example.test')) fail()
  const identityResult = syntheticPatientIdentitySchema.safeParse({
    address: address.line.join(''),
    displayName: name.text,
    email,
    insuranceDisplay: '合成医疗保障',
    mrn: mrn.value,
    nationalId: residentId.value,
    phone,
  })
  if (!identityResult.success) fail(identityResult.error)
  return { identity: identityResult.data, provenance }
}
