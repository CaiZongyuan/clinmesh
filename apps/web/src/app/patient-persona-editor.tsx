import { patientPersonaContentSchema, type PatientPersonaContent } from '@clinmesh/contracts/scenario'
import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { useMutation } from '@tanstack/react-query'
import { useId, useState } from 'react'
import { ApiClientError, createPatientPersonaRevision, newIdempotencyKey } from './api-client.ts'
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

export function PatientPersonaEditor({ caseId, content, locale, onCancel, onSaved }: {
  caseId: string
  content: PatientPersonaContent
  locale: WorkspaceLocale
  onCancel: () => void
  onSaved: () => Promise<void>
}): React.JSX.Element {
  const [draft, setDraft] = useState(content)
  const id = useId()
  const zh = locale === 'zh-CN'
  const save = useMutation({
    mutationFn: (forceDiagnosisLeakOverride: boolean) => createPatientPersonaRevision({
      caseId, content: patientPersonaContentSchema.parse(draft), forceDiagnosisLeakOverride,
    }, newIdempotencyKey()),
    onSuccess: onSaved,
  })
  const warning = save.error instanceof ApiClientError && save.error.code === 'PERSONA_DIAGNOSIS_LEAK_WARNING'
  return (
    <form aria-label={zh ? '编辑患者档案' : 'Edit patient persona'} onSubmit={event => {
      event.preventDefault()
      save.mutate(false)
    }}>
      <FieldGroup>
        {fields.map(([key, nameZh, nameEn, maxLength]) => <Field key={key}>
          <FieldLabel htmlFor={`${id}-${key}`}>{zh ? nameZh : nameEn}</FieldLabel>
          <Textarea disabled={save.isPending} id={`${id}-${key}`} maxLength={maxLength} required value={draft[key]} onChange={event => {
            save.reset()
            setDraft({ ...draft, [key]: event.target.value })
          }} />
        </Field>)}
        {traits.map(([key, nameZh, nameEn]) => <Field key={key}>
          <FieldLabel htmlFor={`${id}-${key}`}>{zh ? nameZh : nameEn}</FieldLabel>
          <Textarea disabled={save.isPending} id={`${id}-${key}`} maxLength={300} required value={draft.persona[key]} onChange={event => {
            save.reset()
            setDraft({ ...draft, persona: { ...draft.persona, [key]: event.target.value } })
          }} />
        </Field>)}
        {save.error === null ? null : <Alert variant="destructive">
          <AlertTitle>{warning ? (zh ? '档案可能透露本次诊断' : 'Possible diagnosis disclosure') : (zh ? '保存失败' : 'Save failed')}</AlertTitle>
          <AlertDescription>{warning
            ? (zh ? '请核对是否属于患者已知的既往史；确认后可以强制保存。' : 'Check whether this is known prior history before saving anyway.')
            : save.error.message}</AlertDescription>
        </Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button disabled={save.isPending} onClick={onCancel} type="button" variant="outline">{zh ? '取消' : 'Cancel'}</Button>
          {warning ? <Button disabled={save.isPending} onClick={() => save.mutate(true)} type="button" variant="destructive">{zh ? '确认并强制保存' : 'Confirm and save anyway'}</Button> : null}
          <Button disabled={save.isPending} type="submit">{zh ? '保存为新修订' : 'Save new revision'}</Button>
        </div>
      </FieldGroup>
    </form>
  )
}
