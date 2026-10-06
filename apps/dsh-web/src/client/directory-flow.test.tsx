import type { Context } from '@deepseek-ai/cordis'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, vi } from 'vitest'
import { registerDirectoryFlow } from './directory-flow.tsx'

const sourceKey = 'sidebar.workspaces.directoryFlow'
const aliasKey = 'clinmesh.history.directoryFlow'

function registry() {
  const core = new SlotCore()
  const register = (options: object, component: unknown) => core.register(options as never, component as never)
  const disposeOwner = register({ name: 'root', children: {
    [sourceKey]: { kind: 'single', scope: 'root' },
    [aliasKey]: { kind: 'single', scope: 'root' },
  } }, () => null)
  const ctx = {
    slots: {
      register,
      entriesOfSlot: (key: string) => core.entriesOfSlot(key),
      subscribe: (key: string, listener: () => void) => core.subscribe(key, listener),
      inject: (key: string, install: () => () => void) => {
        let dispose: (() => void) | undefined
        const sync = () => {
          dispose?.()
          dispose = core.specDynamic(key) ? install() : undefined
        }
        const unsubscribe = core.subscribeDeclaration(key, sync)
        sync()
        return () => { unsubscribe(); dispose?.() }
      },
    },
  }
  return { core, register, disposeOwner, ctx: ctx as unknown as Context }
}

it('registers the composed leaf under its own slot and leaves the native winner intact', () => {
  const { core, register, disposeOwner, ctx } = registry()
  const NativeFlow = () => null
  const pick = vi.fn()
  const inject = vi.fn(() => ({ pick }))
  const disposeNative = register({ name: sourceKey, inject }, NativeFlow)
  const original = core.entriesOfSlot(sourceKey)[0]
  const dispose = registerDirectoryFlow(ctx)
  try {
    expect(core.entriesOfSlot(sourceKey)).toEqual([original])
    const alias = core.entriesOfSlot(aliasKey)[0]!
    expect(alias.component).toBe(NativeFlow)
    expect(alias.inject?.()).toEqual({ pick })
    expect(inject).toHaveBeenCalledOnce()
    dispose()
    expect(core.entriesOfSlot(aliasKey)).toEqual([])
    expect(core.entriesOfSlot(sourceKey)).toEqual([original])
  } finally {
    dispose()
    disposeNative()
    disposeOwner()
  }
})

it('follows source winner changes and removes aliases when the provider or declaration disappears', async () => {
  const { core, register, disposeOwner, ctx } = registry()
  const NativeFlow = () => null
  const BrowseFlow = () => null
  const disposeNative = register({ name: sourceKey, priority: 1 }, NativeFlow)
  const dispose = registerDirectoryFlow(ctx)
  try {
    const disposeBrowse = register({ name: sourceKey, priority: 0 }, BrowseFlow)
    await Promise.resolve()
    expect(core.entriesOfSlot(aliasKey)[0]?.component).toBe(BrowseFlow)
    disposeBrowse()
    await Promise.resolve()
    expect(core.entriesOfSlot(aliasKey)[0]?.component).toBe(NativeFlow)
    disposeNative()
    await Promise.resolve()
    expect(core.entriesOfSlot(aliasKey)).toEqual([])
    register({ name: sourceKey }, BrowseFlow)
    await Promise.resolve()
    expect(core.entriesOfSlot(aliasKey)[0]?.component).toBe(BrowseFlow)
    disposeOwner()
    expect(core.entries(aliasKey)).toEqual([])
    expect(core.entries(sourceKey)).toEqual([])
  } finally {
    dispose()
    disposeNative()
    disposeOwner()
  }
})

it('does not clone a provider with child ownership outside the supported leaf contract', () => {
  const { core, register, disposeOwner, ctx } = registry()
  const disposeNative = register({ name: sourceKey, children: {
    'qa.directory-flow.child': { kind: 'single', scope: 'root' },
  } }, () => null)
  const original = core.entriesOfSlot(sourceKey)[0]
  const dispose = registerDirectoryFlow(ctx)
  try {
    expect(core.entriesOfSlot(aliasKey)).toEqual([])
    expect(core.entriesOfSlot(sourceKey)).toEqual([original])
    expect(core.specDynamic('qa.directory-flow.child')).toBeDefined()
  } finally {
    dispose()
    disposeNative()
    disposeOwner()
  }
})
