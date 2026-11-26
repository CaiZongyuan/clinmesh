import { z } from 'zod';
import type { WorkspaceView } from '../packages/clinical-core';
import { sessionSchema } from '../packages/platform';

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
export function write(workspace: WorkspaceView, intent: Intent) {
  const op = workspace.operations.find(operation => operation.name === intent.name && operation.method !== 'GET');
  if (!op || !op.path.startsWith('/api/')) throw Error('ROLE_FORBIDDEN');
  const path = op.path.replace(':id', encodeURIComponent(intent.targetId ?? ''));
  return api(path, z.record(z.string(), z.json()), jsonBody(op.method, {
    ...intent.fields, epoch: workspace.epoch, expectedVersion: intent.version, idempotencyKey: crypto.randomUUID(),
  }));
}

const messages: Record<string, [string, string]> = {
  INVALID_VISITOR_PASSCODE: ['Incorrect visitor passcode.', '访客口令不正确。'], VISITOR_GATE_UNCONFIGURED: ['The Visitor Gate has not been configured.', '访客门禁尚未配置。'],
  VISITOR_AUTH_REQUIRED: ['Your session has expired. Enter again.', '会话已到期，请重新进入。'], ROLE_FORBIDDEN: ['Switch to a role with permission for this action.', '请切换到具有此权限的岗位。'],
  VERSION_CONFLICT: ['The record changed. Review the latest version before retrying.', '记录已有更新，请核对最新版本。'],
  REQUIRED_FIELDS_MISSING: ['Complete all required record fields before signing.', '请先填写所有必填病历字段。'],
  ONE_PRIMARY_DIAGNOSIS_REQUIRED: ['Choose exactly one primary diagnosis.', '请选择唯一的主诊断。'], COMPLETION_BLOCKED: ['Review the outstanding completion checks.', '请先核对尚未通过的完诊条件。'],
  PATIENT_REPLY_PENDING: ['A patient reply is pending.', '正在等候患者回复。'],
  FIELD_NOT_IN_TEMPLATE: ['Review the current template and any edits under the previous template.', '请核对当前模板与既往模板字段的更正。'],
  RETIRED_FIELDS_REQUIRE_REVIEW: ['Review and resolve previous template corrections before signing.', '请核对并处置既往模板字段的更正后再签署。'],
  CASE_ALREADY_ACTIVE: ['This case already has an active encounter. Select it in the encounter list.', '该病例已有进行中的就诊，请从就诊列表打开。'],
};
export function errorMessage(error: Error, language: Language) {
  const text = messages[error.message];
  return text ? words(language)(...text) : `${words(language)('Request failed', '请求失败')} · ${error.message}`;
}
