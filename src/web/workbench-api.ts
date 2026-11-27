import { z } from 'zod';
import type { EncounterView, WorkspaceView } from '../packages/clinical-core';
import { sessionSchema } from '../packages/platform';
import { modelHeaders } from './model-preferences';
import { sendWorkbenchCommand } from './assistant-command';

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
  return sendWorkbenchCommand(workspace, idempotencyKey => {
    const init = jsonBody(op.method, { ...intent.fields, epoch: workspace.epoch, expectedVersion: intent.version, idempotencyKey });
    return api(path, z.record(z.string(), z.json()), { ...init, mode: 'same-origin', redirect: 'error', headers: { ...init.headers, ...(['consultation.question', 'consultation.retry'].includes(intent.name) ? modelHeaders('patient') : {}) } });
  });
}

const messages: Record<string, [string, string]> = {
  VOICE_UNCONFIGURED: ['Add a Bailian key in Voice settings or choose Browser Web Speech.', '请在语音设置中填写百炼密钥，或选择 Browser Web Speech。'],
  VOICE_AUTH_FAILED: ['Bailian rejected the voice key. Check Voice settings.', '百炼拒绝了语音密钥，请检查语音设置。'],
  VOICE_RATE_LIMITED: ['Bailian voice quota or rate limit reached.', '百炼语音额度或请求速率已达上限。'],
  VOICE_MIC_UNAVAILABLE: ['Microphone unavailable. Check microphone permission and input device.', '麦克风不可用，请检查录音权限和输入设备。'],
  VOICE_MIC_NOT_READY: ['The microphone was still opening. Hold again until the live indicator appears.', '麦克风尚在开启，请重新按住直至出现采集指示。'],
  VOICE_BROWSER_STT_UNAVAILABLE: ['This browser does not provide speech recognition. Select Bailian in Voice settings.', '当前浏览器不支持语音识别，请在语音设置中选择百炼。'],
  VOICE_BROWSER_TTS_UNAVAILABLE: ['Speech playback is unavailable in this browser.', '当前浏览器不支持语音播报。'],
  VOICE_BROWSER_STT_FAILED: ['Browser speech recognition failed. Check permission and connection.', '浏览器语音识别失败，请检查权限及网络连接。'],
  VOICE_TIMEOUT: ['The voice session timed out. Start the microphone again.', '语音会话超时，请重新开启麦克风。'],
  VOICE_CONNECTION_FAILED: ['Voice connection failed. Check the workbench connection.', '语音连接失败，请检查工作台连接。'],
  VOICE_PROVIDER_FAILED: ['The voice provider could not complete the request.', '语音提供商未能完成请求。'],
  VOICE_HTTPS_REQUIRED: ['Open the workbench over HTTPS to use Bailian.', '请使用 HTTPS 访问工作台以接入百炼。'],
  FRONT_PAGE_RESUBMISSION_REQUIRED: ['Submit a new front page for the current diagnosis revision and repeat coding review.', '请按当前确诊修订重新提交病案首页并审核编码。'],
  ADMISSION_DIAGNOSIS_REVIEW_REQUIRED: ['Review the diagnosis draft and POA on the ward Orders tab before discharge.', '请住院主管医生在「诊断医嘱」核对草稿中每项诊断的 POA 后办理出院。'],
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
  VISIBLE_SURGERY_REQUIRED: ['Select a documented prior surgery from this case.', '请选择本病例已记录的既往手术。'],
  REPORT_REVIEW_MODE_INVALID: ['Review this report’s first frame or its image-load failure before confirming.', '请查看此报告的首帧或图像加载失败提示后再确认。'],
};
export function errorMessage(error: Error, language: Language) {
  const text = messages[error.message];
  return text ? words(language)(...text) : `${words(language)('Request failed', '请求失败')} · ${error.message}`;
}
