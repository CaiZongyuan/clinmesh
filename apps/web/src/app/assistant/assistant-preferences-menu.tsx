import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Input } from '@clinmesh/ui/components/input'
import {
  Popover,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@clinmesh/ui/components/popover'
import { Switch } from '@clinmesh/ui/components/switch'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BookMarkedIcon,
  CheckIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  createClinicianMemory,
  deleteClinicianMemory,
  listClinicianMemories,
  updateClinicianMemory,
} from '../agent-sessions-api.ts'

const INSTRUCTION_PRESETS = [
  {
    id: 'soap',
    labelZh: 'SOAP 病历格式',
    labelEn: 'SOAP format',
    textZh: '请统一按 SOAP（主观资料 S / 客观资料 O / 评估 A / 处置计划 P）结构输出，突出关键鉴别点。',
    textEn: 'Format responses in structured SOAP (Subjective, Objective, Assessment, Plan) notes.',
  },
  {
    id: 'bullets',
    labelZh: '简明要点清单',
    labelEn: 'Concise bullets',
    textZh: '回复保持极简要点列表，每条不超过两行，优先标出高风险警示与待核实项。',
    textEn: 'Keep replies ultra-concise bullet checklists, prioritizing safety alerts and missing workup.',
  },
  {
    id: 'ddx',
    labelZh: '鉴别诊断矩阵',
    labelEn: 'DDx matrix',
    textZh: '以 Markdown 表格列出前 3–5 个鉴别诊断、支持依据、不支持依据及下一步首选检查。',
    textEn: 'Present top 3-5 differentials in a Markdown table with supporting, opposing, and next-step columns.',
  },
] as const

export interface AssistantPreferencesMenuProps {
  sessionId: string | null
  customInstructions: string | null | undefined
  autoCompact: boolean
  onSaveSessionSettings: (input: { customInstructions?: string | null; autoCompact?: boolean }) => void
  savePending: boolean
  openOverride?: boolean
  onOpenOverrideChange?: (open: boolean) => void
  zh: boolean
}

/**
 * Combined Session Clinical Instructions (/instructions), Auto-Compaction policy toggle,
 * and Human-in-the-Loop Clinician Memory (Approve / Discard) popover.
 */
export function AssistantPreferencesMenu({
  sessionId,
  customInstructions,
  autoCompact,
  onSaveSessionSettings,
  savePending,
  openOverride,
  onOpenOverrideChange,
  zh,
}: AssistantPreferencesMenuProps): React.JSX.Element {
  const queryClient = useQueryClient()
  const [internalOpen, setInternalOpen] = useState(false)
  const open = openOverride ?? internalOpen
  const setOpen = (next: boolean) => {
    setInternalOpen(next)
    onOpenOverrideChange?.(next)
  }

  const [instructionsDraft, setInstructionsDraft] = useState(customInstructions ?? '')
  const [newMemoryDraft, setNewMemoryDraft] = useState('')

  useEffect(() => {
    setInstructionsDraft(customInstructions ?? '')
  }, [customInstructions, sessionId])

  const memoryQuery = useQuery({
    queryKey: ['clinician-memory'],
    queryFn: ({ signal }) => listClinicianMemories(signal),
    enabled: open,
    retry: false,
  })

  const createMemMutation = useMutation({
    mutationFn: (content: string) => createClinicianMemory({ content, status: 'approved' }),
    onSuccess: (data) => {
      setNewMemoryDraft('')
      queryClient.setQueryData(['clinician-memory'], data)
    },
  })

  const updateMemMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'approved' | 'discarded' }) =>
      updateClinicianMemory(id, { status }),
    onSuccess: (data) => {
      queryClient.setQueryData(['clinician-memory'], data)
    },
  })

  const deleteMemMutation = useMutation({
    mutationFn: (id: string) => deleteClinicianMemory(id),
    onSuccess: (data) => {
      queryClient.setQueryData(['clinician-memory'], data)
    },
  })

  const memories = memoryQuery.data?.items ?? []
  const pendingMemories = memories.filter(item => item.status === 'pending')
  const approvedMemories = memories.filter(item => item.status === 'approved')
  const hasIndicator = pendingMemories.length > 0 || Boolean(customInstructions && customInstructions.trim().length > 0)

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={(
          <Button
            aria-label={zh ? '会话临床指令与医生偏好记忆' : 'Session instructions and clinician memory'}
            className="relative"
            data-testid="assistant-preferences-trigger"
            size="icon-sm"
            title={zh ? '临床指令与记忆' : 'Instructions & Memory'}
            type="button"
            variant="ghost"
          />
        )}
      >
        <BookMarkedIcon aria-hidden="true" className="size-4" />
        {hasIndicator ? (
          <span aria-hidden="true" className="absolute top-1 right-1 size-1.5 rounded-full bg-info" />
        ) : null}
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-80 p-0"
        data-testid="assistant-preferences-popover"
      >
        <div className="border-b border-border px-3 py-2">
          <PopoverTitle className="text-xs font-semibold">
            {zh ? '会话指令与医生偏好记忆' : 'Session instructions & memory'}
          </PopoverTitle>
          <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">
            {zh
              ? '偏好记忆须经医生人工批准才生效，不包含患者个人信息。'
              : 'Memories require explicit clinician approval and never store patient PII.'}
          </p>
        </div>

        <div className="cm-assistant-scroll max-h-96 space-y-3 overflow-y-auto p-3">
          {/* Auto-compaction policy (Default ON) */}
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-foreground">
                {zh ? '自动上下文压缩' : 'Auto context compaction'}
              </div>
              <div className="text-[0.6875rem] text-muted-foreground">
                {zh ? '默认开启，长对话接近窗口上限时自动概括早期轮次' : 'On by default for long clinical threads'}
              </div>
            </div>
            <Switch
              aria-label={zh ? '切换当前会话自动压缩' : 'Toggle session auto compaction'}
              checked={autoCompact}
              data-testid="assistant-pref-autocompact-switch"
              disabled={savePending}
              onCheckedChange={checked => onSaveSessionSettings({ autoCompact: checked })}
            />
          </div>

          {/* Session-level clinical instructions (/instructions) */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">
                {zh ? '当前会话临床指令 (/instructions)' : 'Session instructions (/instructions)'}
              </span>
              {customInstructions ? (
                <Badge className="px-1.5 py-0 text-[0.625rem]" variant="secondary">
                  {sessionId === null ? (zh ? '将在首条消息生效' : 'Pending first send') : (zh ? '已生效' : 'Active')}
                </Badge>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1">
              {INSTRUCTION_PRESETS.map(preset => (
                <Button
                  aria-label={zh ? `应用模板：${preset.labelZh}` : `Apply template: ${preset.labelEn}`}
                  className="h-5 px-1.5 text-[0.6875rem]"
                  key={preset.id}
                  onClick={() => setInstructionsDraft(zh ? preset.textZh : preset.textEn)}
                  size="xs"
                  type="button"
                  variant="outline"
                >
                  {zh ? preset.labelZh : preset.labelEn}
                </Button>
              ))}
            </div>
            <Textarea
              aria-label={zh ? '编辑当前会话临床指令' : 'Edit session clinical instructions'}
              className="min-h-16 text-xs"
              data-testid="assistant-instructions-textarea"
              maxLength={4_000}
              onChange={event => setInstructionsDraft(event.currentTarget.value)}
              placeholder={zh ? '例如：仅输出要点清单，重点提示药物禁忌…' : 'e.g. Concise bullet checklists only…'}
              value={instructionsDraft}
            />
            <div className="flex items-center justify-end gap-1.5">
              {instructionsDraft.trim().length > 0 ? (
                <Button
                  aria-label={zh ? '清除会话临床指令' : 'Clear session instructions'}
                  disabled={savePending}
                  onClick={() => {
                    setInstructionsDraft('')
                    onSaveSessionSettings({ customInstructions: null })
                  }}
                  size="xs"
                  type="button"
                  variant="ghost"
                >
                  {zh ? '清除' : 'Clear'}
                </Button>
              ) : null}
              <Button
                aria-label={zh ? '保存会话临床指令' : 'Save session instructions'}
                data-testid="assistant-instructions-save"
                disabled={savePending}
                onClick={() => onSaveSessionSettings({ customInstructions: instructionsDraft.trim() || null })}
                size="xs"
                type="button"
                variant="default"
              >
                {zh ? '应用指令' : 'Apply'}
              </Button>
            </div>
          </div>

          {/* Clinician Preference Memory (Approve / Discard) */}
          <div className="space-y-2 border-t border-border pt-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground">
                {zh ? '医生长期偏好记忆' : 'Clinician preference memory'}
              </span>
              <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
                {zh ? `${approvedMemories.length} 条已批准` : `${approvedMemories.length} approved`}
              </span>
            </div>

            {pendingMemories.length > 0 ? (
              <div className="space-y-1.5">
                <div className="text-[0.6875rem] font-medium text-warning">
                  {zh ? `待审批提案（${pendingMemories.length}）` : `Pending approval (${pendingMemories.length})`}
                </div>
                {pendingMemories.map(item => (
                  <div
                    className="space-y-1.5 rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs"
                    data-testid={`memory-pending-${item.id}`}
                    key={item.id}
                  >
                    <p className="leading-snug text-foreground">{item.content}</p>
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        aria-label={zh ? `批准记忆：${item.content}` : `Approve memory: ${item.content}`}
                        data-testid="memory-approve-btn"
                        disabled={updateMemMutation.isPending}
                        onClick={() => updateMemMutation.mutate({ id: item.id, status: 'approved' })}
                        size="xs"
                        type="button"
                        variant="default"
                      >
                        <CheckIcon aria-hidden="true" className="size-3" data-icon="inline-start" />
                        {zh ? '批准' : 'Approve'}
                      </Button>
                      <Button
                        aria-label={zh ? `忽略记忆：${item.content}` : `Discard memory: ${item.content}`}
                        data-testid="memory-discard-btn"
                        disabled={updateMemMutation.isPending}
                        onClick={() => updateMemMutation.mutate({ id: item.id, status: 'discarded' })}
                        size="xs"
                        type="button"
                        variant="ghost"
                      >
                        <XIcon aria-hidden="true" className="size-3" data-icon="inline-start" />
                        {zh ? '忽略' : 'Discard'}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {approvedMemories.length > 0 ? (
              <div className="space-y-1">
                {approvedMemories.map(item => (
                  <div
                    className="flex items-start justify-between gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
                    data-testid="memory-approved-item"
                    key={item.id}
                  >
                    <span className="leading-snug text-foreground">{item.content}</span>
                    <Button
                      aria-label={zh ? `删除已批准记忆：${item.content}` : `Delete memory: ${item.content}`}
                      disabled={deleteMemMutation.isPending}
                      onClick={() => deleteMemMutation.mutate(item.id)}
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <Trash2Icon aria-hidden="true" />
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[0.6875rem] text-muted-foreground">
                {zh ? '暂无已批准的长期偏好记忆。' : 'No approved clinician preferences yet.'}
              </p>
            )}

            <form
              className="flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                const trimmed = newMemoryDraft.trim()
                if (trimmed.length === 0 || createMemMutation.isPending) return
                createMemMutation.mutate(trimmed)
              }}
            >
              <Input
                aria-label={zh ? '新增医生偏好记忆' : 'Add clinician preference'}
                className="h-7 flex-1 text-xs"
                data-testid="memory-add-input"
                maxLength={600}
                onChange={event => setNewMemoryDraft(event.currentTarget.value)}
                placeholder={zh ? '添加通用习惯（如：首选中文指南术语）…' : 'Add reusable preference…'}
                value={newMemoryDraft}
              />
              <Button
                aria-label={zh ? '确认添加偏好记忆' : 'Confirm add preference'}
                data-testid="memory-add-submit"
                disabled={newMemoryDraft.trim().length === 0 || createMemMutation.isPending}
                size="icon-xs"
                type="submit"
                variant="outline"
              >
                <PlusIcon aria-hidden="true" />
              </Button>
            </form>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
