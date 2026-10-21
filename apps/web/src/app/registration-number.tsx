import { Button } from '@clinmesh/ui/components/button'
import { CopyIcon } from 'lucide-react'
import { useState } from 'react'
import type { getWorkspaceMessages } from './workspace-i18n.ts'

type RegistrationNumberProps = {
  messages: ReturnType<typeof getWorkspaceMessages>
  registrationNumber: string | null
}

export function RegistrationNumber(props: RegistrationNumberProps): React.JSX.Element {
  // A different number owns fresh copy feedback, including late clipboard responses.
  return <RegistrationNumberValue key={props.registrationNumber} {...props} />
}

function RegistrationNumberValue({ messages, registrationNumber }: RegistrationNumberProps): React.JSX.Element {
  const [result, setResult] = useState<'copied' | 'failed'>()
  return <span className="inline-flex min-w-0 max-w-full flex-wrap items-center gap-x-1 gap-y-0.5" data-registration-number>
    <span className="shrink-0">{messages.registrationNumber}：</span>
    <span className="min-w-0 break-all font-mono tabular-nums select-text" data-registration-number-value>{registrationNumber ?? messages.registrationNumberNotRecorded}</span>
    {registrationNumber === null ? null : <Button aria-label={`${messages.copyRegistrationNumber} ${registrationNumber}`}
      onClick={async () => {
        setResult(undefined)
        try {
          await navigator.clipboard.writeText(registrationNumber)
          setResult('copied')
        } catch { setResult('failed') }
      }} size="icon-xs" type="button" variant="ghost"><CopyIcon aria-hidden="true" /></Button>}
    {result === undefined ? null : <span className="basis-full text-xs text-muted-foreground" role={result === 'failed' ? 'alert' : 'status'}>
      {result === 'copied' ? messages.registrationNumberCopied : messages.registrationNumberCopyFailed}
    </span>}
  </span>
}
