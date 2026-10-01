import dcmjs from 'dcmjs'

const { DicomDict, DicomMetaDictionary } = dcmjs.data
dcmjs.log.level = 'silent'

export const explicitVrLittleEndian = '1.2.840.10008.1.2.1'
export const jpegBaseline = '1.2.840.10008.1.2.4.50'

interface SyntheticInstance {
  attributes: Record<string, unknown>
  pixels: Int16Array | Uint16Array
  transferSyntaxUid?: string | undefined
}

/** 用 dcmjs 写出只含合成像素与虚构 UID 的 DICOM 实例。 */
export function syntheticDicom(instance: SyntheticInstance): Uint8Array {
  const sopInstanceUid = String(instance.attributes.SOPInstanceUID)
  const sopClassUid = String(instance.attributes.SOPClassUID)
  const meta = {
    FileMetaInformationVersion: new Uint8Array([0, 1]).buffer,
    ImplementationClassUID: '2.25.900000000000000000000000000000000001',
    MediaStorageSOPClassUID: sopClassUid,
    MediaStorageSOPInstanceUID: sopInstanceUid,
    TransferSyntaxUID: instance.transferSyntaxUid ?? explicitVrLittleEndian,
  }
  const dictionary = new DicomDict(DicomMetaDictionary.denaturalizeDataset(meta))
  dictionary.dict = DicomMetaDictionary.denaturalizeDataset({
    ...instance.attributes,
    PixelData: [instance.pixels.buffer.slice(
      instance.pixels.byteOffset,
      instance.pixels.byteOffset + instance.pixels.byteLength,
    )],
    _vrMap: { PixelData: 'OW', PixelPaddingValue: 'SS' },
  })
  return new Uint8Array(dictionary.write())
}

export function syntheticCtSlice(input: {
  attributes?: Record<string, unknown> | undefined
  columns?: number
  imageOrientationPatient?: number[]
  pixels: number[]
  rows?: number
  seriesInstanceUid: string
  sopInstanceUid: string
  transferSyntaxUid?: string | undefined
  z: number
}): Uint8Array {
  return syntheticDicom({
    attributes: {
      BitsAllocated: 16,
      BitsStored: 16,
      Columns: input.columns ?? 3,
      HighBit: 15,
      ImageOrientationPatient: input.imageOrientationPatient ?? [1, 0, 0, 0, 1, 0],
      ImagePositionPatient: [-10, -10, input.z],
      Modality: 'CT',
      PhotometricInterpretation: 'MONOCHROME2',
      PixelPaddingValue: -2000,
      PixelRepresentation: 1,
      PixelSpacing: [0.7, 0.8],
      RescaleIntercept: -1024,
      RescaleSlope: 1,
      Rows: input.rows ?? 2,
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      SOPInstanceUID: input.sopInstanceUid,
      SamplesPerPixel: 1,
      SeriesInstanceUID: input.seriesInstanceUid,
      SliceThickness: 80,
      StudyInstanceUID: '2.25.100',
      ...input.attributes,
    },
    pixels: Int16Array.from(input.pixels),
    transferSyntaxUid: input.transferSyntaxUid,
  })
}

export function syntheticRadiograph(input: {
  attributes?: Record<string, unknown>
  columns?: number
  pixels: number[] | Uint16Array
  rows?: number
  seriesInstanceUid: string
  sopInstanceUid: string
}): Uint8Array {
  return syntheticDicom({
    attributes: {
      BitsAllocated: 16,
      BitsStored: 12,
      Columns: input.columns ?? 3,
      HighBit: 11,
      ImagerPixelSpacing: [0.2, 0.2],
      Modality: 'DX',
      PatientOrientation: ['R', 'F'],
      PhotometricInterpretation: 'MONOCHROME1',
      PixelRepresentation: 0,
      PixelSpacing: [0.2, 0.2],
      Rows: input.rows ?? 2,
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.1.1',
      SOPInstanceUID: input.sopInstanceUid,
      SamplesPerPixel: 1,
      SeriesInstanceUID: input.seriesInstanceUid,
      StudyInstanceUID: '2.25.200',
      ViewPosition: 'PA',
      WindowCenter: 1000,
      WindowWidth: 2000,
      ...input.attributes,
    },
    pixels: input.pixels instanceof Uint16Array ? input.pixels : Uint16Array.from(input.pixels),
  })
}
