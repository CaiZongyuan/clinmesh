import { create } from 'zustand'

interface ChatHandoffState {
  pendingDraft: string | null
  targetSessionId: string | null
  setHandoff: (input: { draft?: string | null; sessionId?: string | null }) => void
  consumeHandoff: () => { draft: string | null; sessionId: string | null }
}

export const useChatHandoffStore = create<ChatHandoffState>((set, get) => ({
  pendingDraft: null,
  targetSessionId: null,
  setHandoff: ({ draft = null, sessionId = null }) =>
    set({ pendingDraft: draft, targetSessionId: sessionId }),
  consumeHandoff: () => {
    const current = get()
    set({ pendingDraft: null, targetSessionId: null })
    return { draft: current.pendingDraft, sessionId: current.targetSessionId }
  },
}))
