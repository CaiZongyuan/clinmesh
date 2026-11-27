import { z } from 'zod';
import type { EncounterView, WorkspaceView } from '../packages/clinical-core';
import { sessionSchema } from '../packages/platform';
import { modelHeaders } from './model-preferences';

export type Session = z.infer<typeof sessionSchema>;
export type Language = 'en' | 'zh';
export const words = (language: Language) => (english: string, chinese: string) => language === 'zh' ? chinese : english;
export const sessionKey = ['visitor-session'] as const;
export const scopeKey = (session: Session, ...domain: string[]) => [session.workspaceId, session.epoch, ...domain];
export const workspaceKey = (session: Session) => scopeKey(session, 'workspace', session.roleId);
export class ApiError extends Error {
  constructor(readonly status: number, code: string, readonly details?: Record<string, string | number>) { super(code); }
}

export async function api<Value>(path: string, schema: z.ZodType<Value>, init?: RequestInit) {
  const response = await fetch(path, init);
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ code: z.string(), details: z.record(z.string(), z.union([z.string(), z.number()])).optional() }).safeParse(body).data;
    throw new ApiError(response.status, error?.code ?? `HTTP_${response.status}`, error?.details);
  }
  return schema.parse(body);
}

export async function currentSession(signal: AbortSignal) {
  try { return await api('/api/auth/session', sessionSchema, { signal }); }
  catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
}
export const jsonBody = (method: string, body: unknown) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export type Intent = { name: string; version: number; targetId?: string; encounterId?: string; fields?: Record<string, unknown> };
export type WorkbenchStationProps = { workspace: WorkspaceView; language: Language; submit(intent: Intent): Promise<unknown> };
export type WorkbenchPanelProps = WorkbenchStationProps & { encounter: EncounterView };
export function write(workspace: WorkspaceView, intent: Intent) {
  const op = workspace.operations.find(operation => operation.name === intent.name && operation.method !== 'GET');
  if (!op || !op.path.startsWith('/api/')) throw Error('ROLE_FORBIDDEN');
  const path = op.path.replace(':id', encodeURIComponent(intent.targetId ?? ''));
  const init = jsonBody(op.method, {
    ...intent.fields, epoch: workspace.epoch, expectedVersion: intent.version, idempotencyKey: crypto.randomUUID(),
  });
  return api(path, z.record(z.string(), z.json()), { ...init, mode: 'same-origin', redirect: 'error', headers: { ...init.headers, ...(['consultation.question', 'consultation.retry'].includes(intent.name) ? modelHeaders('patient') : {}) } });
}

const messages: Record<string, [string, string]> = {
  INVALID_VISITOR_PASSCODE: ['Incorrect visitor passcode.', '访客口令不正确。'], VISITOR_GATE_UNCONFIGURED: ['The Visitor Gate has not been configured.', '访客门禁尚未配置。'],
  VISITOR_AUTH_REQUIRED: ['Your session has expired. Enter again.', '会话已到期，请重新进入。'], ROLE_FORBIDDEN: ['Switch to a role with permission for this action.', '请切换到具有此权限的岗位。'],
  VERSION_CONFLICT: ['The record changed. Review the latest version before retrying.', '记录已有更新，请核对最新版本。'],
  REQUIRED_FIELDS_MISSING: ['Complete all required record fields before signing.', '请先填写所有必填病历字段。'],
  ONE_PRIMARY_DIAGNOSIS_REQUIRED: ['Choose exactly one primary diagnosis.', '请选择唯一的主诊断。'], COMPLETION_BLOCKED: ['Review the outstanding completion checks.', '请先核对尚未通过的完诊条件。'],
  CONSULTATION_REPLY_IN_FLIGHT: ['A patient reply is pending.', '正在等候患者回复。'],
  LLM_PROVIDER_UNCONFIGURED: ['Configure a provider or enable Mock Mode.', '请配置模型提供商或启用 Mock Mode。'],
  LLM_PROVIDER_AUTH_FAILED: ['The provider rejected the credential. Check your API key.', '提供商拒绝了认证，请核对 API 密钥。'],
  LLM_PROVIDER_RATE_LIMITED: ['The provider is rate limiting requests. Retry later.', '模型提供商已限流，请稍后重试。'],
  LLM_PROVIDER_TIMEOUT: ['The provider timed out. Retry the patient reply.', '等待模型提供商超时，请重试患者回复。'],
  LLM_PROVIDER_FAILED: ['The provider could not answer. Check your model settings and retry.', '模型提供商未能应答，请核对模型设置并重试。'],
  LLM_PROVIDER_EMPTY_REPLY: ['The provider returned no answer text. Check the model or reasoning setting and retry.', '模型提供商没有返回正文，请检查模型或思考强度后重试。'],
  LLM_HTTPS_REQUIRED: ['Open this workbench over HTTPS before sending an API key.', '请使用 HTTPS 打开工作台后再发送 API 密钥。'],
  LLM_ENDPOINT_NOT_ALLOWED: ['Choose a provider endpoint allowed by this host.', '请选择此服务允许的模型地址。'],
  LLM_REJOIN_CONFIGURATION_REQUIRED: ['Restore the original model settings to resume, or stop and retry.', '请恢复原模型设置以续接，或停止后重试。'],
  PATIENT_REPLY_NEEDS_RESUME: ['Resume this pending question with your current model settings.', '使用当前模型设置续答此问题。'],
  FIELD_NOT_IN_TEMPLATE: ['Review the current template and any edits under the previous template.', '请核对当前模板与既往模板字段的更正。'],
  RETIRED_FIELDS_REQUIRE_REVIEW: ['Review and resolve previous template corrections before signing.', '请核对并处置既往模板字段的更正后再签署。'],
  CASE_ALREADY_ACTIVE: ['This case already has an active encounter. Select it in the encounter list.', '该病例已有进行中的就诊，请从就诊列表打开。'],
  CATALOG_CONFLICT: ['Review the catalog version and price, then save the item again.', '请重新核对目录版本与单价后保存项目。'],
  ACTIVE_ORDER_EXISTS: ['This investigation already has an open request.', '同一服务已有未终结申请。'],
  CLINICAL_DOCUMENT_UNSIGNED: ['Sign the clinical record before issuing orders.', '正式开单前请先签署病历。'],
  DIAGNOSIS_UNCONFIRMED: ['Confirm the primary diagnosis before issuing orders.', '正式开单前请确认主诊断。'],
  PAYMENT_REQUIRED: ['Payment clearance is required before acceptance.', '受理前须完成收费放行。'],
  CHARGE_LOCKED: ['The linked financial record prevents cancellation.', '关联账项当前禁止取消申请。'],
  AMENDMENT_UNAVAILABLE: ['No authored correction is available for this report.', '这份报告暂无已编写的更正版本。'],
  REPORT_SUPERSEDED: ['Open the latest report version to review it.', '请打开报告的最新版本进行审阅。'],
};
export function errorMessage(error: Error, language: Language) {
  const text = messages[error.message];
  return text ? words(language)(...text) : `${words(language)('Request failed', '请求失败')} · ${error.message}`;
}
