import type { ModelUsageAttempt, ModelUsageContext } from '@clinmesh/contracts/model-usage'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const zh = {
  overview: '用量总览', requests: '请求明细', policy: '额度与策略', pricing: '计价说明',
  coverage: '监控覆盖范围',
  coverageDescription: '已覆盖 Server 直接模型调用和经 DSH bridge 发起的调用。Host 独立识别将在 #262 接入；其他 DSH 原生会话及插件发起的调用未覆盖。',
  aggregateScope: '总览汇总当前 Workspace 的全部 Epoch；请求明细仅显示当前业务权限允许的记录。',
  memberScope: '普通成员的明细限于活动 Epoch，历史 Epoch 明细仅管理员可查看。',
  dispatched: '已派发请求', knownTokens: '已知 Token', cost: '人民币费用', outstanding: '在途与未决',
  dispatchScope: '排除确认未派发的尝试；派发情况未知的请求保守计入。', dispatchState: '派发状态',
  unknown: '未知', notReturned: '未返回', unpriced: '未配置价格', inFlight: '在途', unresolved: '结果未知',
  unknownTokenRequests: '次请求存在未知 Token', unpricedRequests: '次请求缺价，费用总额未知',
  reservations: '当前额度无限，无有限额度预占；在途和未知结果仍持续记账。',
  trend: '调用趋势', distribution: '功能分布', recent: '最近请求', allRequests: '查看全部明细',
  date: '日期', feature: '功能', provider: 'Provider', model: '模型', result: '结果',
  from: '开始日期', to: '结束日期', caseId: '病例 ID', all: '全部', apply: '应用筛选', reset: '重置',
  filters: '筛选用量', refresh: '刷新用量', invalidFilters: '请检查筛选条件；开始日期不能晚于结束日期。',
  requestTime: '请求时间', token: 'Token', requestCount: '请求数', detail: '请求详情',
  viewDetail: '查看请求详情', closeDetail: '收起详情', empty: '暂无模型调用',
  emptyDescription: '当前筛选和授权范围内没有请求记录。', loading: '正在读取模型用量…',
  loadError: '模型用量读取失败', retry: '重试读取', detailError: '请求详情读取失败或已无权访问',
  previous: '上一页', next: '下一页', total: '条授权记录', page: '页',
  attemptId: '尝试 ID', task: '任务', stage: '阶段', epoch: 'Epoch', encounter: '就诊 ID',
  trigger: '触发方式', requestKind: '请求类型', requestedModel: '请求模型', actualModel: '实际模型',
  reasoning: '推理强度', outputLimit: '输出上限', startedAt: '开始时间', endedAt: '结束时间',
  providerRequest: 'Provider 请求 ID', httpStatus: 'HTTP 状态', mapping: '计量映射',
  inputTokens: '输入 Token', outputTokens: '输出 Token', cachedTokens: '缓存输入 Token（输入子集）',
  reasoningTokens: '推理输出 Token（输出子集）', totalTokens: '总 Token',
  tokenExplanation: '缓存输入包含在输入中，推理输出包含在输出中，子集不重复相加。未返回的用量保持未知，失败或取消不视为零消耗。',
  sources: '来源关联', sourceKind: '来源类型', triggerSources: '触发来源', evidenceSources: '证据来源', noSources: '无可信来源关联',
  sourceDescription: '展示已记录的业务关联；多条触发与证据不代表完整因果关系。',
  enabled: '已启用', unlimited: '无限', requestLimit: '请求次数上限', tokenLimit: 'Token 上限', costLimit: '人民币费用上限',
  policyDescription: '当前开放只读监控，模型生成已启用，三项额度均为无限。',
  futurePolicy: 'Workspace 额度管理、自动重试策略、保留期设置与待确认用量核对将在后续版本提供。',
  priceDescription: '尚未配置统一价表，当前请求的人民币费用均为未知；未知金额不表示免费。',
  priceDetails: '计价与汇率快照、只读价表及人民币估算将在后续版本提供。估算金额不等于服务商实际扣费。',
}

const en: Record<keyof typeof zh, string> = {
  overview: 'Usage overview', requests: 'Requests', policy: 'Quotas and policy', pricing: 'Pricing',
  coverage: 'Monitoring coverage',
  coverageDescription: 'Covers direct Server model calls and calls sent through the DSH bridge. Independent Host recognition will be added in #262; other DSH native sessions and plugin calls are outside this coverage.',
  aggregateScope: 'Overview totals span all Epochs in this Workspace; request details follow your existing business access.',
  memberScope: 'Members can access authorized details in the active Epoch. Historical Epoch details require an administrator.',
  dispatched: 'Dispatched requests', knownTokens: 'Known tokens', cost: 'CNY cost', outstanding: 'In flight and unresolved',
  dispatchScope: 'Excludes attempts confirmed as not dispatched; unknown dispatch is conservatively included.', dispatchState: 'Dispatch status',
  unknown: 'Unknown', notReturned: 'Not returned', unpriced: 'Price not configured', inFlight: 'In flight', unresolved: 'Unknown result',
  unknownTokenRequests: 'requests have unknown tokens', unpricedRequests: 'requests lack pricing; total cost is unknown',
  reservations: 'Quotas are unlimited, so no finite quota is reserved. In-flight and unknown results remain recorded.',
  trend: 'Call trend', distribution: 'Calls by feature', recent: 'Recent requests', allRequests: 'View all requests',
  date: 'Date', feature: 'Feature', provider: 'Provider', model: 'Model', result: 'Result',
  from: 'Start date', to: 'End date', caseId: 'Case ID', all: 'All', apply: 'Apply filters', reset: 'Reset',
  filters: 'Filter usage', refresh: 'Refresh usage', invalidFilters: 'Check filters; the start date must not follow the end date.',
  requestTime: 'Request time', token: 'Tokens', requestCount: 'Requests', detail: 'Request detail',
  viewDetail: 'View request detail', closeDetail: 'Close detail', empty: 'No model calls yet',
  emptyDescription: 'There are no requests within these filters and your access scope.', loading: 'Reading model usage…',
  loadError: 'Unable to read model usage', retry: 'Retry reading', detailError: 'Request detail is unavailable or access has changed',
  previous: 'Previous page', next: 'Next page', total: 'authorized records', page: 'Page',
  attemptId: 'Attempt ID', task: 'Task', stage: 'Stage', epoch: 'Epoch', encounter: 'Encounter ID',
  trigger: 'Trigger', requestKind: 'Request kind', requestedModel: 'Requested model', actualModel: 'Actual model',
  reasoning: 'Reasoning effort', outputLimit: 'Output limit', startedAt: 'Started at', endedAt: 'Ended at',
  providerRequest: 'Provider request ID', httpStatus: 'HTTP status', mapping: 'Usage mapping',
  inputTokens: 'Input tokens', outputTokens: 'Output tokens', cachedTokens: 'Cached input tokens (input subset)',
  reasoningTokens: 'Reasoning output tokens (output subset)', totalTokens: 'Total tokens',
  tokenExplanation: 'Cached input is included in input, and reasoning output is included in output. Subsets are never added twice. Unreported usage stays unknown; failure or cancellation does not imply zero usage.',
  sources: 'Source associations', sourceKind: 'Source type', triggerSources: 'Trigger sources', evidenceSources: 'Evidence sources', noSources: 'No trusted source associations',
  sourceDescription: 'These are recorded business associations. Multiple triggers and evidence do not imply complete causality.',
  enabled: 'Enabled', unlimited: 'Unlimited', requestLimit: 'Request limit', tokenLimit: 'Token limit', costLimit: 'CNY cost limit',
  policyDescription: 'Read-only monitoring is available. Model generation is enabled and all three quotas are unlimited.',
  futurePolicy: 'Workspace quotas, automatic retry policy, retention settings and unresolved usage reconciliation will be available in a later version.',
  priceDescription: 'No shared price table is configured. CNY costs are unknown; unknown cost does not mean free.',
  priceDetails: 'Pricing and exchange-rate snapshots, a read-only price table and CNY estimates will be available in a later version. Estimates are not provider billing receipts.',
}

const features: Record<ModelUsageAttempt['feature'], readonly [string, string]> = {
  patient_persona: ['患者人设', 'Patient persona'], patient_dialogue_reply: ['患者回答', 'Patient reply'],
  consultation_history_increment: ['问诊自动记录', 'Consultation recording'],
  consultation_history_summary: ['问诊记录整理', 'Consultation summary'],
  investigation_result: ['检查结果', 'Investigation result'], investigation_service_result: ['检查服务结果', 'Investigation service result'],
  laboratory_service_enrichment: ['检验目录完善', 'Laboratory catalog enrichment'],
  doctor_recommendations: ['诊疗建议', 'Doctor recommendations'],
  doctor_recommendation_history_selection: ['建议病史筛选', 'Recommendation history selection'],
  doctor_recommendation_history_consolidation: ['建议病史收敛', 'Recommendation history consolidation'],
  doctor_recommendation_catalog_selection: ['建议目录筛选', 'Recommendation catalog selection'],
  doctor_recommendation_verification: ['诊疗建议核验', 'Recommendation verification'],
  clinical_document_quality: ['病历质控', 'Document quality check'],
  clinical_document_quality_verification: ['病历质控核验', 'Document quality verification'],
}
const statuses: Record<ModelUsageAttempt['status'], readonly [string, string]> = {
  'in-flight': ['在途', 'In flight'], succeeded: ['成功', 'Succeeded'], failed: ['失败', 'Failed'],
  cancelled: ['已取消', 'Cancelled'], unknown: ['结果未知', 'Unknown result'],
}
const kinds: Record<ModelUsageAttempt['kind'], readonly [string, string]> = {
  initial: ['首次请求', 'Initial request'], 'format-repair': ['格式纠错', 'Format repair'], 'rate-limit-retry': ['限流重发', 'Rate-limit retry'],
}
const dispatches: Record<ModelUsageAttempt['dispatch'], readonly [string, string]> = {
  dispatched: ['已派发', 'Dispatched'], 'not-dispatched': ['未派发', 'Not dispatched'], unknown: ['派发情况未知', 'Unknown dispatch'],
}
const triggers: Record<ModelUsageContext['trigger'], readonly [string, string]> = {
  automatic: ['自动', 'Automatic'], manual: ['手动', 'Manual'], recovery: ['恢复', 'Recovery'], unknown: ['未知', 'Unknown'],
}

export function modelUsageMessages(locale: WorkspaceLocale) {
  const index = locale === 'zh-CN' ? 0 : 1
  return { ...(index === 0 ? zh : en),
    featureLabel: (value: ModelUsageAttempt['feature']) => features[value][index],
    statusLabel: (value: ModelUsageAttempt['status']) => statuses[value][index],
    dispatchLabel: (value: ModelUsageAttempt['dispatch']) => dispatches[value][index],
    kindLabel: (value: ModelUsageAttempt['kind']) => kinds[value][index],
    triggerLabel: (value: ModelUsageContext['trigger']) => triggers[value][index],
  }
}
