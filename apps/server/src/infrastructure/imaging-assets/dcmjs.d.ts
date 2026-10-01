// dcmjs 不发布类型声明；这里只声明摄取与测试 fixture 实际使用的接口。
declare module 'dcmjs' {
  type DicomJson = Record<string, unknown>

  class DicomDict {
    constructor(meta: DicomJson)
    dict: DicomJson
    meta: DicomJson
    write(): ArrayBuffer
  }

  const dcmjs: {
    data: {
      DicomDict: typeof DicomDict
      DicomMessage: {
        readFile(buffer: ArrayBuffer, options?: { ignoreErrors?: boolean }): DicomDict
      }
      DicomMetaDictionary: {
        denaturalizeDataset(dataset: DicomJson): DicomJson
        naturalizeDataset(dataset: DicomJson): DicomJson
      }
    }
    log: { level: string }
  }

  export default dcmjs
}
