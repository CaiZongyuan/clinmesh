// DSH 单文件产物不压缩依赖，阅片引擎因此直接引用 OpenSeadragon 的压缩构建；类型沿用包内声明。
declare module 'openseadragon/build/openseadragon/openseadragon.min.js' {
  import OpenSeadragon from 'openseadragon'
  export default OpenSeadragon
}
