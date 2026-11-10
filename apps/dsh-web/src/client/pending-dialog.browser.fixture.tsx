import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@clinmesh/ui/components/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger } from '@clinmesh/ui/components/alert-dialog'

const host = document.createElement('div')
document.body.append(host)
const shadow = host.attachShadow({ mode: 'open' })
for (const style of document.querySelectorAll('style')) shadow.append(style.cloneNode(true))
const root = document.createElement('div')
root.className = 'clinmesh-web-root'
shadow.append(root)

function Fixture(): React.JSX.Element {
  const [mode, setMode] = React.useState<'controlled' | 'uncontrolled' | 'confirmation'>()
  const [open, setOpen] = React.useState(true)
  const [pending, setPending] = React.useState(false)
  const [nestedPending, setNestedPending] = React.useState(false)
  const [identity, setIdentity] = React.useState(0)
  const [result, setResult] = React.useState('idle')
  const [closeRequests, setCloseRequests] = React.useState(0)
  const run = async () => {
    setPending(true)
    setResult('pending')
    const response = await fetch('/synthetic-mutation', { method: 'POST' })
    setResult(response.ok ? 'complete' : 'failed')
    setPending(false)
  }
  const onOpenChange = (next: boolean) => {
    setOpen(next)
    if (!next) setCloseRequests(value => value + 1)
  }
  return <>
    <button onClick={() => setMode('controlled')}>Open controlled dialog</button>
    <button onClick={() => setMode('uncontrolled')}>Open uncontrolled dialog</button>
    <button onClick={() => setMode('confirmation')}>Open confirmation</button>
    <button onClick={() => setOpen(false)}>Host close</button>
    <button onClick={() => { setIdentity(value => value + 1); setOpen(false) }}>Host switch</button>
    <button onClick={() => setMode(undefined)}>Host unmount</button>
    <output aria-label="Mutation result">{result}</output>
    <output aria-label="Close requests">{closeRequests}</output>
    {mode === 'confirmation' ? <AlertDialog key={identity} open={open} onOpenChange={onOpenChange} pending={pending}>
      <AlertDialogContent>
        <AlertDialogTitle>Synthetic confirmation</AlertDialogTitle>
        <AlertDialogDescription>Confirm a synthetic request.</AlertDialogDescription>
        <AlertDialogCancel disabled={false}>Cancel</AlertDialogCancel>
        <AlertDialogAction disabled={pending} onClick={() => void run()}>Confirm</AlertDialogAction>
      </AlertDialogContent>
    </AlertDialog> : mode ? <Dialog key={identity} {...(mode === 'controlled' ? { open } : { defaultOpen: true })} onOpenChange={onOpenChange} pending={pending}>
      <DialogTrigger>Reopen dialog</DialogTrigger>
      <DialogContent>
        <DialogTitle>Synthetic dialog</DialogTitle>
        <DialogDescription>Run a synthetic request.</DialogDescription>
        <button disabled={pending} onClick={() => void run()}>Submit</button>
        <DialogClose disabled={false}>Cancel</DialogClose>
        <AlertDialog pending={nestedPending}>
          <AlertDialogTrigger>Open nested confirmation</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogTitle>Nested confirmation</AlertDialogTitle>
            <AlertDialogDescription>An independent synthetic request.</AlertDialogDescription>
            <AlertDialogCancel>Nested cancel</AlertDialogCancel>
            <AlertDialogAction disabled={nestedPending} onClick={() => {
              setNestedPending(true)
              void fetch('/synthetic-nested-mutation', { method: 'POST' }).then(() => setNestedPending(false))
            }}>Nested confirm</AlertDialogAction>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog> : null}
  </>
}

createRoot(root).render(<PortalContainerProvider container={root}><Fixture /></PortalContainerProvider>)
