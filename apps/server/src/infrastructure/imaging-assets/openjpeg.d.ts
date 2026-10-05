// @cornerstonejs/codec-openjpeg 不发布类型声明；这里只声明切片摄取与测试 fixture 实际使用的接口。
declare module '@cornerstonejs/codec-openjpeg/decodewasmjs' {
  interface FrameInfo {
    bitsPerSample: number
    componentCount: number
    height: number
    isSigned: boolean
    width: number
  }

  class J2KDecoder {
    decode(): void
    /** 返回 WASM 内存中的视图，下一次解码前必须复制。 */
    getDecodedBuffer(): Uint8Array
    getEncodedBuffer(length: number): Uint8Array
    getFrameInfo(): FrameInfo
  }

  export default function factory(module?: {
    print?: (message: string) => void
    printErr?: (message: string) => void
  }): Promise<{ J2KDecoder: typeof J2KDecoder }>
}

declare module '@cornerstonejs/codec-openjpeg/wasmjs' {
  class J2KEncoder {
    encode(): void
    getDecodedBuffer(frameInfo: {
      bitsPerSample: number
      componentCount: number
      height: number
      isSigned: boolean
      isUsingColorSpace: boolean
      width: number
    }): Uint8Array
    getEncodedBuffer(): Uint8Array
    setDecompositions(decompositions: number): void
    setQuality(lossless: boolean, quality: number): void
  }

  export default function factory(): Promise<{ J2KEncoder: typeof J2KEncoder }>
}
