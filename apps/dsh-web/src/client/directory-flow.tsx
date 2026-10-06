import type { ReactNode } from 'react'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'

export type DirectoryFlowOwner = DirectoryFlowOwnerProps

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'clinmesh.history.directoryFlow': {
      kind: 'single'
      scope: 'root'
      owner: DirectoryFlowOwner
    }
  }
}

/** Reuse the pinned host's composed native/browse leaf without stealing its child slot. */
export function registerDirectoryFlow(ctx: Context): () => void {
  return ctx.slots.inject('sidebar.workspaces.directoryFlow', () => {
    let source: StoredEntry | undefined
    let dispose: (() => void) | undefined
    const sync = () => {
      const winner = ctx.slots.entriesOfSlot('sidebar.workspaces.directoryFlow')[0]
      if (source === winner) return
      dispose?.()
      source = winner
      dispose = undefined
      if (!winner) return
      // The registry exposes an erased inspection view, not a picker factory.
      // Only the two pinned root-scoped, stateless provider leaves are reusable.
      if (winner.store || winner.locale || Object.keys(winner.children ?? {}).length > 0) return
      dispose = ctx.slots.register({
        name: 'clinmesh.history.directoryFlow',
        inject: () => winner.inject?.() ?? {},
      }, winner.component as (props: DirectoryFlowOwner) => ReactNode)
    }
    sync()
    const unsubscribe = ctx.slots.subscribe('sidebar.workspaces.directoryFlow', sync)
    return () => { unsubscribe(); dispose?.() }
  })
}
