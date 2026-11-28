import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@clinmesh/ui/components/card'
import { Input } from '@clinmesh/ui/components/input'
import { Switch } from '@clinmesh/ui/components/switch'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@clinmesh/ui/components/table'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CpuIcon,
  MicroscopeIcon,
  PlusIcon,
  ShieldCheckIcon,
  SparklesIcon,
  StethoscopeIcon,
  Trash2Icon,
} from 'lucide-react'
import { useState } from 'react'
import {
  createClinicianMemory,
  deleteClinicianMemory,
  getLlmProviderCatalog,
  listAgentSessions,
  listClinicianMemories,
  updateClinicianMemory,
} from '../agent-sessions-api.ts'
import { useLlmSettings } from '../llm-settings-storage.ts'
import type { WorkspaceLocale } from '../workspace-i18n.ts'
import { useChatHandoffStore } from './chat-handoff.ts'

type AgentTab = 'profiles' | 'memory' | 'skills'

const READ_ONLY_TOOLS = [
  { name: 'read_visible_case_summary', zh: '读取当前可见病例摘要（不含隐藏真值）', en: 'Read visible case summary', scope: '只读' },
  { name: 'read_lab_results', zh: '读取可见检验报告与异常标红', en: 'Read visible lab reports', scope: '只读' },
  { name: 'read_imaging_reports', zh: '读取可见影像与功能检查报告', en: 'Read visible imaging & exam reports', scope: '只读' },
  { name: 'read_medication_orders', zh: '读取处方、在院医嘱与过敏史', en: 'Read medications, orders & allergies', scope: '只读' },
  { name: 'read_vital_trends', zh: '读取生命体征与医患问诊记录', en: 'Read vital trends & consultation turns', scope: '只读' },
  { name: 'propose_clinician_preference', zh: '提议医生长期工作偏好（需医生人工批准）', en: 'Propose clinician preference (approval gated)', scope: '审批写入' },
] as const

export function PersonalAgentSpace({
  locale,
  session,
  clinicalHomePath,
  onNavigate,
}: {
  locale: WorkspaceLocale
  session: SessionContext
  clinicalHomePath: string
  onNavigate: (path: string) => void
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const queryClient = useQueryClient()
  const llmSettings = useLlmSettings()
  const setChatHandoff = useChatHandoffStore(s => s.setHandoff)
  const [tab, setTab] = useState<AgentTab>('profiles')
  const [newMemoryText, setNewMemoryText] = useState('')

  const memoryQuery = useQuery({
    queryKey: ['clinician-memories', session.actor.workspaceId],
    queryFn: ({ signal }) => listClinicianMemories(signal),
  })

  const catalogQuery = useQuery({
    queryKey: ['llm-provider-catalog'],
    queryFn: ({ signal }) => getLlmProviderCatalog({ signal }),
  })

  const sessionsQuery = useQuery({
    queryKey: ['agent-sessions-all', session.actor.workspaceId, session.actor.epoch],
    queryFn: ({ signal }) => listAgentSessions(undefined, signal),
  })

  const createMemoryMutation = useMutation({
    mutationFn: (content: string) =>
      createClinicianMemory({ content, status: 'approved' }),
    onSuccess: data => {
      queryClient.setQueryData(['clinician-memories', session.actor.workspaceId], data)
      setNewMemoryText('')
    },
  })

  const updateMemoryMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'approved' | 'discarded' }) =>
      updateClinicianMemory(id, { status }),
    onSuccess: data => {
      queryClient.setQueryData(['clinician-memories', session.actor.workspaceId], data)
    },
  })

  const deleteMemoryMutation = useMutation({
    mutationFn: (id: string) => deleteClinicianMemory(id),
    onSuccess: data => {
      queryClient.setQueryData(['clinician-memories', session.actor.workspaceId], data)
    },
  })

  const memories = memoryQuery.data?.items ?? []
  const localProviders = catalogQuery.data?.localProviders ?? []
  const sessionCount = sessionsQuery.data?.sessions.length ?? 0

  const launchAgentInChat = (prompt: string) => {
    setChatHandoff({ draft: prompt, sessionId: null })
    onNavigate('/chat')
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Top Subheader */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-card px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label={zh ? '个人 Agent 分区' : 'Personal agent sections'}
            onValueChange={values => {
              const next = (values as AgentTab[])[0]
              if (next) setTab(next)
            }}
            size="sm"
            spacing={0}
            value={[tab]}
            variant="outline"
          >
            <ToggleGroupItem value="profiles">
              {zh ? '我的智能体与模型' : 'Agents & Models'}
            </ToggleGroupItem>
            <ToggleGroupItem value="memory">
              {zh ? `偏好记忆 (${memories.length})` : `Memory (${memories.length})`}
            </ToggleGroupItem>
            <ToggleGroupItem value="skills">
              {zh ? '技能与安全边界' : 'Skills & Guardrails'}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="secondary">
            {zh ? `持久化会话 ${sessionCount} 条` : `${sessionCount} saved sessions`}
          </Badge>
          <Button onClick={() => onNavigate('/settings/models')} size="sm" type="button" variant="outline">
            <CpuIcon aria-hidden="true" className="size-3.5" />
            <span>{zh ? '模型与 CLI 配置' : 'Models & CLI'}</span>
          </Button>
        </div>
      </div>

      {/* Main Content */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          {tab === 'profiles' ? (
            <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="flex size-8 items-center justify-center rounded-md bg-accent text-accent-foreground">
                          <StethoscopeIcon aria-hidden="true" className="size-4" />
                        </span>
                        <div>
                          <CardTitle className="text-sm">{zh ? '临床工作台助手' : 'Clinical Workbench Assistant'}</CardTitle>
                          <CardDescription className="text-xs">{zh ? '右侧抽屉 · 绑定当前接诊病例' : 'Right drawer · encounter-bound'}</CardDescription>
                        </div>
                      </div>
                      <Badge variant="secondary">{llmSettings.mockMode ? 'Mock' : zh ? '就绪' : 'Ready'}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 text-xs text-muted-foreground">
                    <p>
                      {zh
                        ? '自动读取当前可见病例摘要、检验、影像、医嘱与生命体征，协助整理 12 字段病历草稿并核对过敏红线。'
                        : 'Reads visible labs, imaging, orders, and vitals to assist structured charting while respecting confirmation gates.'}
                    </p>
                    <div className="flex items-center justify-between pt-1">
                      <span className="font-mono text-[11px]">{llmSettings.assistant.modelId || 'Default model'}</span>
                      <Button onClick={() => onNavigate(clinicalHomePath)} size="xs" type="button" variant="outline">
                        {zh ? '打开工作台' : 'Open Clinic'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="flex size-8 items-center justify-center rounded-md bg-accent text-accent-foreground">
                          <ShieldCheckIcon aria-hidden="true" className="size-4" />
                        </span>
                        <div>
                          <CardTitle className="text-sm">{zh ? '处方与 DRG 质控顾问' : 'Rx & DRG Quality Reviewer'}</CardTitle>
                          <CardDescription className="text-xs">{zh ? '全屏聊天启动 · 只读循证核查' : 'Full-screen chat · read-only audit'}</CardDescription>
                        </div>
                      </div>
                      <Badge variant="secondary">{zh ? '可用' : 'Active'}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 text-xs text-muted-foreground">
                    <p>
                      {zh
                        ? '用于独立复核抗菌药物选择、青霉素/磺胺类交叉过敏风险、肾功能剂量调整与住院 DRG 分组核查。'
                        : 'Reviews antibiotic regimens, allergy cross-reactivity, renal dosing, and inpatient DRG grouping.'}
                    </p>
                    <div className="flex items-center justify-between pt-1">
                      <span className="font-mono text-[11px]">pi-durable</span>
                      <Button
                        onClick={() => launchAgentInChat(zh
                          ? '请以处方与临床质控顾问身份，结合循证指南帮我核查以下用药方案的过敏与肾功能风险：'
                          : 'Act as a clinical medication & DRG quality reviewer and audit the following regimen: ')}
                        size="xs"
                        type="button"
                        variant="outline"
                      >
                        {zh ? '在聊天页启动' : 'Launch in Chat'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="flex size-8 items-center justify-center rounded-md bg-accent text-accent-foreground">
                          <MicroscopeIcon aria-hidden="true" className="size-4" />
                        </span>
                        <div>
                          <CardTitle className="text-sm">{zh ? '科研队列与病例复盘员' : 'Cohort & Case Analyst'}</CardTitle>
                          <CardDescription className="text-xs">{zh ? '衔接科研空间与合成患者库' : 'Connected to Research space'}</CardDescription>
                        </div>
                      </div>
                      <Badge variant="secondary">{zh ? '可用' : 'Active'}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3 text-xs text-muted-foreground">
                    <p>
                      {zh
                        ? '支持从「临床科研」筛选脱敏合成患者队列并一键带入全屏聊天页，汇总指标分布与教学复盘要点。'
                        : 'Analyzes filtered synthetic patient cohorts handed off from the Research space.'}
                    </p>
                    <div className="flex items-center justify-between pt-1">
                      <span className="font-mono text-[11px]">Cohort → Chat</span>
                      <Button onClick={() => onNavigate('/research')} size="xs" type="button" variant="outline">
                        {zh ? '前往科研空间' : 'Open Research'}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Local Discovered CLI Providers from Step 3 */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <BotIcon aria-hidden="true" className="size-4 text-info" />
                    <span>{zh ? '本机已发现模型配置（来自 Step 3 本地 CLI 扫描）' : 'Discovered Local CLI Providers'}</span>
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {zh
                      ? '只读扫描本机 ~/.pi、~/.claude、~/.codex（绝不暴露密钥），可在临床助手与全屏聊天中无缝切换。'
                      : 'Read-only discovery from local ~/.pi, ~/.claude, and ~/.codex without exposing secrets.'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {localProviders.length === 0 ? (
                    <div className="text-xs text-muted-foreground">
                      {zh
                        ? '当前未检测到本机 CLI Provider 配置，可前往「设置 → 模型与服务商」配置 BYOK 或启用 Mock 模式。'
                        : 'No local CLI providers detected. Configure BYOK or Mock Mode in Settings → Models.'}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {localProviders.map(provider => (
                        <div className="rounded-md border bg-muted/30 p-3 text-xs" key={provider.id}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-foreground">{provider.displayName}</span>
                            <Badge variant="outline">{provider.models.length} models</Badge>
                          </div>
                          <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
                            {provider.source}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          ) : null}

          {tab === 'memory' ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">
                  <SparklesIcon aria-hidden="true" className="size-4 text-info" />
                  <span>{zh ? '医生长期工作偏好与临床指令记忆' : 'Clinician Long-Term Preference Memory'}</span>
                </CardTitle>
                <CardDescription className="text-xs">
                  {zh
                    ? '直连 /api/agents/memory；所有启用条目会注入临床助手与全屏聊天系统上下文，随时可开关或删除。'
                    : 'Backed directly by /api/agents/memory; enabled entries guide both the clinical assistant drawer and full-screen chat.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <form
                  className="flex items-center gap-2"
                  onSubmit={event => {
                    event.preventDefault()
                    const trimmed = newMemoryText.trim()
                    if (trimmed.length > 0) createMemoryMutation.mutate(trimmed)
                  }}
                >
                  <Input
                    aria-label={zh ? '新增医生工作偏好记忆' : 'Add clinician preference memory'}
                    onChange={event => setNewMemoryText(event.currentTarget.value)}
                    placeholder={zh ? '例如：门诊肺炎病例默认附注 CRB-65 评分，并把过敏史置顶提醒…' : 'e.g. Always include CRB-65 score for CAP and highlight allergies first…'}
                    value={newMemoryText}
                  />
                  <Button
                    disabled={createMemoryMutation.isPending || newMemoryText.trim().length === 0}
                    size="sm"
                    type="submit"
                  >
                    <PlusIcon aria-hidden="true" className="size-3.5" />
                    <span>{zh ? '添加记忆' : 'Add'}</span>
                  </Button>
                </form>

                {memoryQuery.isError ? (
                  <Alert variant="destructive">
                    <CircleAlertIcon aria-hidden="true" />
                    <AlertTitle>{zh ? '无法读取偏好记忆' : 'Failed to load memories'}</AlertTitle>
                    <AlertDescription>{zh ? '请稍后重试或检查后端连接。' : 'Please retry.'}</AlertDescription>
                  </Alert>
                ) : memories.length === 0 ? (
                  <div className="rounded-md border border-dashed p-6 text-center text-xs text-muted-foreground">
                    {zh
                      ? '暂无已保存的医生工作偏好记忆。你可以在上方直接添加，或在对话中让助手提议偏好。'
                      : 'No saved clinician memories yet. Add one above or approve assistant proposals.'}
                  </div>
                ) : (
                  <div className="divide-y rounded-md border">
                    {memories.map(item => {
                      const approved = item.status === 'approved'
                      return (
                        <div className="flex items-center justify-between gap-3 px-3.5 py-2.5 text-sm" key={item.id}>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className={approved ? 'text-foreground' : 'text-muted-foreground line-through'}>
                                {item.content}
                              </span>
                              <Badge variant="outline">
                                {item.status === 'pending'
                                  ? (zh ? '待审批' : 'Pending')
                                  : approved
                                    ? (zh ? '已生效' : 'Approved')
                                    : (zh ? '已停用' : 'Disabled')}
                              </Badge>
                            </div>
                          </div>
                          <div className="flex shrink-0 items-center gap-2">
                            <Switch
                              aria-label={zh ? `启用记忆：${item.content.slice(0, 20)}` : 'Toggle memory'}
                              checked={approved}
                              onCheckedChange={checked =>
                                updateMemoryMutation.mutate({
                                  id: item.id,
                                  status: checked ? 'approved' : 'discarded',
                                })}
                            />
                            <Button
                              aria-label={zh ? `删除记忆：${item.content.slice(0, 20)}` : 'Delete memory'}
                              onClick={() => deleteMemoryMutation.mutate(item.id)}
                              size="icon-xs"
                              type="button"
                              variant="ghost"
                            >
                              <Trash2Icon aria-hidden="true" className="size-3.5" />
                            </Button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
          ) : null}

          {tab === 'skills' ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm">{zh ? '已注册临床只读工具与安全边界' : 'Registered Clinical Tools & Safety Boundaries'}</CardTitle>
                <CardDescription className="text-xs">
                  {zh
                    ? '所有临床工具遵循窄 schema、受信会话绑定与完整审计；任何正式医疗写入必须经人工 data-agent-confirm 确认。'
                    : 'All clinical tools enforce narrow schemas, session binding, and human confirmation for clinical writes.'}
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{zh ? '工具标识' : 'Tool ID'}</TableHead>
                      <TableHead>{zh ? '用途说明' : 'Description'}</TableHead>
                      <TableHead>{zh ? '权限边界' : 'Permission'}</TableHead>
                      <TableHead>{zh ? '状态' : 'Status'}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {READ_ONLY_TOOLS.map(tool => (
                      <TableRow key={tool.name}>
                        <TableCell className="font-mono text-xs">{tool.name}</TableCell>
                        <TableCell>{zh ? tool.zh : tool.en}</TableCell>
                        <TableCell><Badge variant="outline">{tool.scope}</Badge></TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            <CheckIcon aria-hidden="true" className="size-3 text-success" />
                            <span>{zh ? '已启用' : 'Enabled'}</span>
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}
