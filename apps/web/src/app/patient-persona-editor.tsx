import { patientPersonaContentSchema, type PatientPersonaContent } from '@clinmesh/contracts/scenario'
import type { SessionContext } from '@clinmesh/contracts/his'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useId, useState } from 'react'
import { ApiClientError } from './api-client.ts'
import { usePatientPersonaWriteIntent } from './patient-persona-write-intent.ts'
import { getWorkspaceErrorMessage } from './workspace-error.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'
import type { WorkspaceLocale } from './workspace-i18n.ts'

const fields = [
  ['chiefComplaint', '主诉', 'Chief complaint', 500],
  ['openingStatement', '开场陈述', 'Opening statement', 1000],
  ['knownHistorySummary', '已知史', 'Known history', 2000],
  ['symptomExperience', '症状体验', 'Symptom experience', 4000],
  ['medicationMemory', '用药记忆', 'Medication memory', 1000],
] as const
const traits = [
  ['character', '性格', 'Character'], ['speechStyle', '说话方式', 'Speech style'],
  ['healthLiteracy', '健康素养', 'Health literacy'], ['attitude', '就医态度', 'Attitude'],
] as const

const emptyPersona: PatientPersonaContent = {
  chiefComplaint: '', openingStatement: '', knownHistorySummary: '', symptomExperience: '', medicationMemory: '',
  persona: { character: '', speechStyle: '', healthLiteracy: '', attitude: '' },
}

export function PatientPersonaEditor({ caseId, content = emptyPersona, locale, session, onCancel, onSaved }: {
  caseId: string
  content?: PatientPersonaContent
  session: SessionContext
  locale: WorkspaceLocale
  onCancel: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const write = usePatientPersonaWriteIntent(session, caseId, 'create', onSaved)
  const [draft, setDraft] = useState(() => write.pending?.command.kind === 'create' ? write.pending.command.content : content)
  const id = useId()
  const zh = locale === 'zh-CN'
  const save = write.mutation
  const error = write.storageFailure ?? save.error
  const warning = save.error instanceof ApiClientError && save.error.code === 'PERSONA_DIAGNOSIS_LEAK_WARNING'
  return (
    <form aria-label={zh ? '编辑患者档案' : 'Edit patient persona'} onSubmit={event => {
      event.preventDefault()
      save.mutate({ kind: 'create', content: draft, forceDiagnosisLeakOverride: false })
    }}>
      <FieldGroup>
        {fields.map(([key, nameZh, nameEn, maxLength]) => <Field key={key}>
          <FieldLabel htmlFor={`${id}-${key}`}>{zh ? nameZh : nameEn}</FieldLabel>
          <Textarea disabled={write.blocked} id={`${id}-${key}`} maxLength={maxLength} required value={draft[key]} onChange={event => {
            save.reset()
            setDraft({ ...draft, [key]: event.target.value })
          }} />
        </Field>)}
        {traits.map(([key, nameZh, nameEn]) => <Field key={key}>
          <FieldLabel htmlFor={`${id}-${key}`}>{zh ? nameZh : nameEn}</FieldLabel>
          <Textarea disabled={write.blocked} id={`${id}-${key}`} maxLength={300} required value={draft.persona[key]} onChange={event => {
            save.reset()
            setDraft({ ...draft, persona: { ...draft.persona, [key]: event.target.value } })
          }} />
        </Field>)}
        {error === null ? null : <Alert variant="destructive">
          <AlertTitle>{warning ? (zh ? '档案可能透露本次诊断' : 'Possible diagnosis disclosure') : (zh ? '保存失败' : 'Save failed')}</AlertTitle>
          <AlertDescription>{warning
            ? (zh ? '请核对是否属于患者已知的既往史；确认后可以强制保存。' : 'Check whether this is known prior history before saving anyway.')
            : write.storageFailure
              ? (zh ? '无法读取或保存恢复信息，请恢复浏览器会话存储后刷新页面。' : 'Recovery information could not be stored. Restore browser session storage and refresh.')
              : getWorkspaceErrorMessage(error, getWorkspaceMessages(locale))}</AlertDescription>
        </Alert>}
        {write.pending !== null && !save.isPending ? <Alert><AlertDescription>
          <p>{zh ? '原档案操作结果待确认，已保留当时内容。' : 'The original persona operation is unconfirmed; its contents are retained.'}</p>
          <Button onClick={() => save.mutate(undefined)} type="button" variant="outline">{zh ? '恢复原档案操作' : 'Recover persona operation'}</Button>
        </AlertDescription></Alert> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={write.blocked} onClick={onCancel} type="button" variant="outline">{zh ? '取消' : 'Cancel'}</Button>
          {warning ? <Button disabled={write.blocked || !patientPersonaContentSchema.safeParse(draft).success} onClick={() => save.mutate({ kind: 'create', content: draft, forceDiagnosisLeakOverride: true })} type="button" variant="destructive">{zh ? '确认并强制保存' : 'Confirm and save anyway'}</Button> : null}
          <Button disabled={write.blocked || !patientPersonaContentSchema.safeParse(draft).success} type="submit">{zh ? '保存为新修订' : 'Save new revision'}</Button>
        </div>
      </FieldGroup>
    </form>
  )
}
