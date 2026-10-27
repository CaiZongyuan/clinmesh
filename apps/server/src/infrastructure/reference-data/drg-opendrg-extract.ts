import { compileDrgProgram } from './drg-program-compiler.ts'

/** 仅解析原程序文本；未知条件使整个提取失败，不执行源码、不跳过判定。 */
export const extractOfficialProgram = compileDrgProgram
