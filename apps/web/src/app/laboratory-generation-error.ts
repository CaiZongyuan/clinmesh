import type { WorkspaceLocale } from './workspace-i18n.ts'

export function laboratoryGenerationErrorMessage(code: string, locale: WorkspaceLocale): string {
  const messages: Record<string, { 'zh-CN': string; 'en-US': string }> = {
    INVESTIGATION_UNSUPPORTED: {
      'zh-CN': '该病例缺少此检验的合成结果底账，无法生成结果。',
      'en-US': 'This case has no synthetic result evidence for this laboratory item.',
    },
    INVESTIGATION_TRUTH_INCOMPATIBLE: {
      'zh-CN': '该病例的合成检验真值与申请的结果定义或单位不兼容，无法生成结果。请取消此申请。',
      'en-US': 'This case’s synthetic laboratory truth is incompatible with the requested result definition or unit. Cancel this request.',
    },
    INVESTIGATION_OUTPUT_INVALID: {
      'zh-CN': '生成结果未通过校验，请重试。',
      'en-US': 'The generated result did not pass validation. Please retry.',
    },
    AI_TIMEOUT: {
      'zh-CN': '结果生成服务响应超时，请重试。',
      'en-US': 'The result generation service timed out. Please retry.',
    },
    AI_REQUEST_FAILED: {
      'zh-CN': '无法连接结果生成服务，请稍后重试。',
      'en-US': 'The result generation service request failed. Please retry later.',
    },
    AI_AUTH_FAILED: {
      'zh-CN': '模型认证或访问权限失败，请检查所选 Provider 的密钥与访问权限后重试。',
      'en-US': 'Model authentication or access failed. Check the selected Provider credentials and access permissions, then retry.',
    },
  }
  return messages[code]?.[locale] ?? (locale === 'zh-CN'
    ? '结果生成失败，可重试。'
    : 'Result generation failed. You can retry.')
}

