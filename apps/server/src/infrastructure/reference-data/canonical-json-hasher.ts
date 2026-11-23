import { createHash, randomUUID, type Hash } from 'node:crypto'
import { closeSync, openSync, readSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ReferenceConcept,
  ReferenceImportManifest,
  ReferenceLaboratoryDefinition,
  ReferenceLaboratoryPanelMember,
  ReferenceLaboratorySpecimen,
  ReferenceLaboratoryUnit,
  ReferenceMedicalService,
  ReferenceMedicationProduct,
  ReferenceSourceManifest,
  ReferenceValueSetEntry,
} from '@clinmesh/contracts/reference-data'

const defaultCollator = new Intl.Collator()
const defaultMaxChunkRows = 1_024
const defaultMaxChunkBytes = 2 * 1024 * 1024
const writeBufferBytes = 64 * 1024
const totalMergeReadBudgetBytes = 4 * 1024 * 1024

type SortKeyPart = number | string
type SortKey = readonly SortKeyPart[]

interface ChunkEntry {
  byteLength: number
  key: SortKey
  ordinal: number
  oversizedBytes?: Buffer
  slabOffset: number
}

interface RunRange {
  endOffset: number
  startOffset: number
}

interface MergeHead {
  jsonBytes: Buffer
  key: SortKey
  ordinal: number
  readerIndex: number
}

interface CachedObjectShape {
  keys: readonly string[]
  sortedKeys: readonly string[]
}

export interface ReleaseContentHashStreamInput {
  concepts: Iterable<ReferenceConcept & { sourceId: string }>
  laboratoryDefinitions?: Iterable<ReferenceLaboratoryDefinition & { sourceId: string }>
  laboratoryPanelMembers?: Iterable<ReferenceLaboratoryPanelMember & { sourceId: string }>
  laboratorySpecimens?: Iterable<ReferenceLaboratorySpecimen & { sourceId: string }>
  laboratoryUnits?: Iterable<ReferenceLaboratoryUnit & { sourceId: string }>
  medicationProducts?: Iterable<ReferenceMedicationProduct & { sourceId: string }>
  release: Pick<ReferenceImportManifest, 'createdAt' | 'releaseId' | 'schemaVersion'>
  services?: Iterable<ReferenceMedicalService & { sourceId: string }>
  sources: readonly ReferenceSourceManifest[]
  valueSetEntries?: Iterable<ReferenceValueSetEntry & { sourceId: string }>
}

export interface ReleaseContentHashOptions {
  maxChunkBytes?: number
  maxChunkRows?: number
  tempDirectory?: string
}

function compareLocaleStrings(left: string, right: string): number {
  return left === right ? 0 : defaultCollator.compare(left, right)
}

function compareSortKeys(left: SortKey, right: SortKey): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = left[index]!
    const rightPart = right[index]!
    const delta = typeof leftPart === 'number' && typeof rightPart === 'number'
      ? leftPart - rightPart
      : compareLocaleStrings(String(leftPart), String(rightPart))
    if (delta !== 0) return delta
  }
  return left.length - right.length
}

function compareRecords(
  left: Pick<ChunkEntry, 'key' | 'ordinal'>,
  right: Pick<ChunkEntry, 'key' | 'ordinal'>,
): number {
  return compareSortKeys(left.key, right.key) || (left.ordinal - right.ordinal)
}

let cachedTopShape: CachedObjectShape | undefined

function matchesCachedShape(keys: readonly string[], cached: CachedObjectShape): boolean {
  if (keys.length !== cached.keys.length) return false
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== cached.keys[index]) return false
  }
  return true
}

function resolveObjectShape(keys: readonly string[], allowCache: boolean): CachedObjectShape {
  if (allowCache && cachedTopShape !== undefined && matchesCachedShape(keys, cachedTopShape)) {
    return cachedTopShape
  }
  const shape: CachedObjectShape = {
    keys: [...keys],
    sortedKeys: [...keys].sort(compareLocaleStrings),
  }
  if (allowCache) cachedTopShape = shape
  return shape
}

function canonicalizeValue(value: unknown, isTopObject: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map(entry => canonicalizeValue(entry, false))
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const shape = resolveObjectShape(keys, isTopObject)
  const sortedRecord: Record<string, unknown> = {}
  for (let index = 0; index < shape.sortedKeys.length; index += 1) {
    const key = shape.sortedKeys[index]!
    const entry = record[key]
    if (entry !== undefined) {
      sortedRecord[key] = canonicalizeValue(entry, false)
    }
  }
  return sortedRecord
}

function canonicalJsonString(value: unknown): string | undefined {
  return JSON.stringify(canonicalizeValue(value, true))
}

function keyPayloadByteLength(key: SortKey): number {
  let byteLength = 1 + 8
  for (const part of key) {
    if (typeof part === 'number') {
      byteLength += 1 + 8
    } else {
      byteLength += 1 + 4 + Buffer.byteLength(part, 'utf8')
    }
  }
  return byteLength
}

function writeKeyPayload(target: Buffer, startOffset: number, key: SortKey, ordinal: number): number {
  let offset = startOffset
  target.writeUInt8(key.length, offset)
  offset += 1
  for (const part of key) {
    if (typeof part === 'number') {
      target.writeUInt8(1, offset)
      offset += 1
      target.writeDoubleLE(part, offset)
      offset += 8
    } else {
      const byteLength = Buffer.byteLength(part, 'utf8')
      target.writeUInt8(0, offset)
      offset += 1
      target.writeUInt32LE(byteLength, offset)
      offset += 4
      target.write(part, offset, byteLength, 'utf8')
      offset += byteLength
    }
  }
  target.writeDoubleLE(ordinal, offset)
  return offset + 8
}

function deserializeKeyPayload(buffer: Buffer, startOffset: number): {
  key: SortKey
  ordinal: number
} {
  let offset = startOffset
  const count = buffer.readUInt8(offset)
  offset += 1
  const key: SortKeyPart[] = []
  for (let index = 0; index < count; index += 1) {
    const kind = buffer.readUInt8(offset)
    offset += 1
    if (kind === 1) {
      key.push(buffer.readDoubleLE(offset))
      offset += 8
    } else {
      const byteLength = buffer.readUInt32LE(offset)
      offset += 4
      key.push(buffer.toString('utf8', offset, offset + byteLength))
      offset += byteLength
    }
  }
  const ordinal = buffer.readDoubleLE(offset)
  return { key, ordinal }
}

class RunWriter {
  readonly #buffer = Buffer.allocUnsafe(writeBufferBytes)
  #bufferedBytes = 0
  readonly #fd: number
  #fileOffset = 0

  constructor(fd: number) {
    this.#fd = fd
  }

  get offset(): number {
    return this.#fileOffset + this.#bufferedBytes
  }

  writeRecord(entry: ChunkEntry, slab: Buffer): void {
    const keyBytes = keyPayloadByteLength(entry.key)
    const jsonBytes = entry.byteLength
    const totalBytes = 8 + keyBytes + jsonBytes
    if (totalBytes <= this.#buffer.byteLength) {
      if (this.#bufferedBytes + totalBytes > this.#buffer.byteLength) {
        this.flush()
      }
      let offset = this.#bufferedBytes
      this.#buffer.writeUInt32LE(keyBytes, offset)
      this.#buffer.writeUInt32LE(jsonBytes, offset + 4)
      offset = writeKeyPayload(this.#buffer, offset + 8, entry.key, entry.ordinal)
      if (entry.oversizedBytes !== undefined) {
        entry.oversizedBytes.copy(this.#buffer, offset)
      } else {
        slab.copy(this.#buffer, offset, entry.slabOffset, entry.slabOffset + jsonBytes)
      }
      this.#bufferedBytes = offset + jsonBytes
      return
    }
    this.flush()
    const oversized = Buffer.allocUnsafe(totalBytes)
    oversized.writeUInt32LE(keyBytes, 0)
    oversized.writeUInt32LE(jsonBytes, 4)
    const afterKey = writeKeyPayload(oversized, 8, entry.key, entry.ordinal)
    if (entry.oversizedBytes !== undefined) {
      entry.oversizedBytes.copy(oversized, afterKey)
    } else {
      slab.copy(oversized, afterKey, entry.slabOffset, entry.slabOffset + jsonBytes)
    }
    let written = 0
    while (written < totalBytes) {
      written += writeSync(this.#fd, oversized, written, totalBytes - written, this.#fileOffset + written)
    }
    this.#fileOffset += totalBytes
  }

  flush(): void {
    if (this.#bufferedBytes === 0) return
    let written = 0
    while (written < this.#bufferedBytes) {
      written += writeSync(
        this.#fd,
        this.#buffer,
        written,
        this.#bufferedBytes - written,
        this.#fileOffset + written,
      )
    }
    this.#fileOffset += this.#bufferedBytes
    this.#bufferedBytes = 0
  }
}

class RunReader {
  readonly #buffer: Buffer
  #bufferEnd = 0
  #bufferStart = 0
  readonly #endOffset: number
  readonly #fd: number
  #fileOffset: number

  constructor(fd: number, range: RunRange, bufferBytes: number) {
    this.#fd = fd
    this.#fileOffset = range.startOffset
    this.#endOffset = range.endOffset
    this.#buffer = Buffer.allocUnsafe(bufferBytes)
  }

  next(): Omit<MergeHead, 'readerIndex'> | undefined {
    if (!this.#ensureAvailable(8)) return undefined
    const keyLength = this.#buffer.readUInt32LE(this.#bufferStart)
    const jsonLength = this.#buffer.readUInt32LE(this.#bufferStart + 4)
    this.#bufferStart += 8
    const payloadLength = keyLength + jsonLength
    if (payloadLength <= this.#buffer.byteLength) {
      if (!this.#ensureAvailable(payloadLength)) {
        throw new Error('Unexpected end of canonical merge run')
      }
      const { key, ordinal } = deserializeKeyPayload(this.#buffer, this.#bufferStart)
      const jsonStart = this.#bufferStart + keyLength
      const jsonBytes = this.#buffer.subarray(jsonStart, jsonStart + jsonLength)
      this.#bufferStart += payloadLength
      return { jsonBytes, key, ordinal }
    }
    const largePayload = Buffer.allocUnsafe(payloadLength)
    const cachedBytes = this.#bufferEnd - this.#bufferStart
    if (cachedBytes > 0) {
      this.#buffer.copy(largePayload, 0, this.#bufferStart, this.#bufferEnd)
      this.#bufferStart = 0
      this.#bufferEnd = 0
    }
    let filled = cachedBytes
    while (filled < payloadLength) {
      const remainingInRun = this.#endOffset - this.#fileOffset
      if (remainingInRun <= 0) throw new Error('Unexpected end of canonical merge run')
      const bytesRead = readSync(
        this.#fd,
        largePayload,
        filled,
        Math.min(payloadLength - filled, remainingInRun),
        this.#fileOffset,
      )
      if (bytesRead <= 0) throw new Error('Unexpected EOF reading canonical merge run')
      this.#fileOffset += bytesRead
      filled += bytesRead
    }
    const { key, ordinal } = deserializeKeyPayload(largePayload, 0)
    return {
      jsonBytes: largePayload.subarray(keyLength, payloadLength),
      key,
      ordinal,
    }
  }

  #ensureAvailable(requiredBytes: number): boolean {
    const available = this.#bufferEnd - this.#bufferStart
    if (available >= requiredBytes) return true
    if (this.#bufferStart > 0 && available > 0) {
      this.#buffer.copy(this.#buffer, 0, this.#bufferStart, this.#bufferEnd)
    }
    this.#bufferStart = 0
    this.#bufferEnd = available
    while (this.#bufferEnd < requiredBytes && this.#fileOffset < this.#endOffset) {
      const toRead = Math.min(
        this.#buffer.byteLength - this.#bufferEnd,
        this.#endOffset - this.#fileOffset,
      )
      const bytesRead = readSync(this.#fd, this.#buffer, this.#bufferEnd, toRead, this.#fileOffset)
      if (bytesRead <= 0) break
      this.#bufferEnd += bytesRead
      this.#fileOffset += bytesRead
    }
    return this.#bufferEnd >= requiredBytes
  }
}

function pushHeap(heap: MergeHead[], item: MergeHead): void {
  heap.push(item)
  let index = heap.length - 1
  while (index > 0) {
    const parentIndex = (index - 1) >> 1
    if (compareRecords(heap[parentIndex]!, heap[index]!) <= 0) break
    const parent = heap[parentIndex]!
    heap[parentIndex] = heap[index]!
    heap[index] = parent
    index = parentIndex
  }
}

function popHeap(heap: MergeHead[]): MergeHead | undefined {
  if (heap.length === 0) return undefined
  const top = heap[0]!
  const last = heap.pop()!
  if (heap.length > 0) {
    heap[0] = last
    let index = 0
    while (true) {
      const left = (index << 1) + 1
      const right = left + 1
      let smallest = index
      if (left < heap.length && compareRecords(heap[left]!, heap[smallest]!) < 0) {
        smallest = left
      }
      if (right < heap.length && compareRecords(heap[right]!, heap[smallest]!) < 0) {
        smallest = right
      }
      if (smallest === index) break
      const current = heap[index]!
      heap[index] = heap[smallest]!
      heap[smallest] = current
      index = smallest
    }
  }
  return top
}

function writeSortedArrayField<Row>(input: {
  alwaysEmit: boolean
  hash: Hash
  key: string
  maxChunkRows: number
  needsComma: boolean
  rows: Iterable<Row>
  slab: Buffer
  sortKey: (row: Row) => SortKey
  tempDirectory: string
}): boolean {
  const chunk: ChunkEntry[] = []
  const runs: RunRange[] = []
  let slabUsed = 0
  let ordinal = 0
  let tempFilePath: string | undefined
  let tempFd: number | undefined
  let writer: RunWriter | undefined

  const spillChunk = (): void => {
    if (chunk.length === 0) return
    chunk.sort(compareRecords)
    if (writer === undefined) {
      tempFilePath = join(
        input.tempDirectory,
        `clinmesh-ref-hash-${process.pid}-${randomUUID()}.tmp`,
      )
      tempFd = openSync(tempFilePath, 'w+', 0o600)
      writer = new RunWriter(tempFd)
    }
    const startOffset = writer.offset
    for (const entry of chunk) {
      writer.writeRecord(entry, input.slab)
    }
    const endOffset = writer.offset
    runs.push({ endOffset, startOffset })
    chunk.length = 0
    slabUsed = 0
  }

  let iterator: Iterator<Row> | undefined
  let iteratorDone = false
  try {
    iterator = input.rows[Symbol.iterator]()
    while (true) {
      const step = iterator.next()
      if (step.done === true) {
        iteratorDone = true
        break
      }
      const json = canonicalJsonString(step.value)
      if (json === undefined) {
        throw new Error(`Canonical row in ${input.key} serialized to undefined`)
      }
      const byteLength = Buffer.byteLength(json, 'utf8')
      if (chunk.length >= input.maxChunkRows
        || (chunk.length > 0 && slabUsed + byteLength > input.slab.byteLength)) {
        spillChunk()
      }
      if (byteLength <= input.slab.byteLength) {
        input.slab.write(json, slabUsed, byteLength, 'utf8')
        chunk.push({
          byteLength,
          key: input.sortKey(step.value),
          ordinal,
          slabOffset: slabUsed,
        })
        slabUsed += byteLength
      } else {
        chunk.push({
          byteLength,
          key: input.sortKey(step.value),
          ordinal,
          oversizedBytes: Buffer.from(json, 'utf8'),
          slabOffset: 0,
        })
      }
      ordinal += 1
    }

    if (ordinal === 0) {
      if (!input.alwaysEmit) return false
      if (input.needsComma) input.hash.update(',')
      input.hash.update(`${JSON.stringify(input.key)}:[]`)
      return true
    }

    if (input.needsComma) input.hash.update(',')
    input.hash.update(`${JSON.stringify(input.key)}:[`)

    if (runs.length === 0) {
      chunk.sort(compareRecords)
      for (let index = 0; index < chunk.length; index += 1) {
        if (index > 0) input.hash.update(',')
        const entry = chunk[index]!
        input.hash.update(
          entry.oversizedBytes
            ?? input.slab.subarray(entry.slabOffset, entry.slabOffset + entry.byteLength),
        )
      }
      chunk.length = 0
      input.hash.update(']')
      return true
    }

    spillChunk()
    writer!.flush()

    const readerBufferBytes = Math.max(
      4_096,
      Math.min(65_536, Math.floor(totalMergeReadBudgetBytes / runs.length)),
    )
    const readers = runs.map(range => new RunReader(tempFd!, range, readerBufferBytes))
    const heap: MergeHead[] = []
    for (let readerIndex = 0; readerIndex < readers.length; readerIndex += 1) {
      const head = readers[readerIndex]!.next()
      if (head !== undefined) pushHeap(heap, { ...head, readerIndex })
    }
    let emitted = 0
    while (heap.length > 0) {
      const current = popHeap(heap)!
      if (emitted > 0) input.hash.update(',')
      input.hash.update(current.jsonBytes)
      emitted += 1
      const next = readers[current.readerIndex]!.next()
      if (next !== undefined) pushHeap(heap, { ...next, readerIndex: current.readerIndex })
    }
    input.hash.update(']')
    return true
  } finally {
    if (iterator !== undefined && !iteratorDone) {
      try {
        iterator.return?.()
      } catch {
        // Preserve original error if closing iterator also throws.
      }
    }
    if (tempFd !== undefined) {
      try {
        closeSync(tempFd)
      } catch {
        // Ignore close failure before unlinking temporary spill file.
      }
    }
    if (tempFilePath !== undefined) {
      rmSync(tempFilePath, { force: true })
    }
  }
}

const emptyIterable: readonly never[] = []

export function computeStreamingReleaseContentHash(
  input: ReleaseContentHashStreamInput,
  options?: ReleaseContentHashOptions,
): string {
  const maxChunkRows = Math.max(1, options?.maxChunkRows ?? defaultMaxChunkRows)
  const maxChunkBytes = Math.max(1, options?.maxChunkBytes ?? defaultMaxChunkBytes)
  const slab = Buffer.allocUnsafe(Math.min(maxChunkBytes, defaultMaxChunkBytes))
  const tempDirectory = options?.tempDirectory ?? tmpdir()
  const hash = createHash('sha256')

  const hashSources = input.sources.map(({ artifactFormat, ...source }) => (
    artifactFormat === 'clinmesh-reference-v1'
      ? source
      : { ...source, artifactFormat }
  ))

  const fields: Array<{
    key: string
    write: (needsComma: boolean) => boolean
  }> = [
    {
      key: 'concepts',
      write: needsComma => writeSortedArrayField({
        alwaysEmit: true,
        hash,
        key: 'concepts',
        maxChunkRows,
        needsComma,
        rows: input.concepts,
        slab,
        sortKey: concept => [concept.sourceId, concept.id],
        tempDirectory,
      }),
    },
    {
      key: 'createdAt',
      write: (needsComma) => {
        if (needsComma) hash.update(',')
        hash.update(`"createdAt":${JSON.stringify(input.release.createdAt)}`)
        return true
      },
    },
    {
      key: 'laboratoryDefinitions',
      write: needsComma => writeSortedArrayField({
        alwaysEmit: false,
        hash,
        key: 'laboratoryDefinitions',
        maxChunkRows,
        needsComma,
        rows: input.laboratoryDefinitions ?? emptyIterable,
        slab,
        sortKey: definition => [definition.sourceId, definition.conceptId],
        tempDirectory,
      }),
    },
    {
      key: 'laboratoryPanelMembers',
      write: needsComma => writeSortedArrayField({
        alwaysEmit: false,
        hash,
        key: 'laboratoryPanelMembers',
        maxChunkRows,
        needsComma,
        rows: input.laboratoryPanelMembers ?? emptyIterable,
        slab,
        sortKey: member => [
          member.sourceId,
          member.panelConceptId,
          member.memberOrder,
          member.memberConceptId,
          member.sourceLocator,
        ],
        tempDirectory,
      }),
    },
    {
      key: 'laboratorySpecimens',
      write: needsComma => writeSortedArrayField({
        alwaysEmit: false,
        hash,
        key: 'laboratorySpecimens',
        maxChunkRows,
        needsComma,
        rows: input.laboratorySpecimens ?? emptyIterable,
        slab,
        sortKey: specimen => [specimen.sourceId, specimen.conceptId, specimen.partNumber],
        tempDirectory,
      }),
    },
    {
      key: 'laboratoryUnits',
      write: needsComma => writeSortedArrayField({
        alwaysEmit: false,
        hash,
        key: 'laboratoryUnits',
        maxChunkRows,
        needsComma,
        rows: input.laboratoryUnits ?? emptyIterable,
        slab,
        sortKey: unit => [unit.sourceId, unit.conceptId, unit.sourceLocator],
        tempDirectory,
      }),
    },
    {
      key: 'medicationProducts',
      write: needsComma => writeSortedArrayField({
        alwaysEmit: false,
        hash,
        key: 'medicationProducts',
        maxChunkRows,
        needsComma,
        rows: input.medicationProducts ?? emptyIterable,
        slab,
        sortKey: product => [product.sourceId, product.id],
        tempDirectory,
      }),
    },
    {
      key: 'releaseId',
      write: (needsComma) => {
        if (needsComma) hash.update(',')
        hash.update(`"releaseId":${JSON.stringify(input.release.releaseId)}`)
        return true
      },
    },
    {
      key: 'schemaVersion',
      write: (needsComma) => {
        if (needsComma) hash.update(',')
        hash.update(`"schemaVersion":${JSON.stringify(input.release.schemaVersion)}`)
        return true
      },
    },
    {
      key: 'services',
      write: needsComma => writeSortedArrayField({
        alwaysEmit: false,
        hash,
        key: 'services',
        maxChunkRows,
        needsComma,
        rows: input.services ?? emptyIterable,
        slab,
        sortKey: service => [service.sourceId, service.id],
        tempDirectory,
      }),
    },
    {
      key: 'sources',
      write: needsComma => writeSortedArrayField({
        alwaysEmit: true,
        hash,
        key: 'sources',
        maxChunkRows,
        needsComma,
        rows: hashSources,
        slab,
        sortKey: source => [source.sourceId],
        tempDirectory,
      }),
    },
    {
      key: 'valueSetEntries',
      write: needsComma => writeSortedArrayField({
        alwaysEmit: false,
        hash,
        key: 'valueSetEntries',
        maxChunkRows,
        needsComma,
        rows: input.valueSetEntries ?? emptyIterable,
        slab,
        sortKey: entry => [entry.sourceId, entry.id],
        tempDirectory,
      }),
    },
  ]

  fields.sort((left, right) => compareLocaleStrings(left.key, right.key))

  hash.update('{')
  let hasField = false
  for (const field of fields) {
    if (field.write(hasField)) {
      hasField = true
    }
  }
  hash.update('}')
  return hash.digest('hex')
}
