import type { AppSpaceId } from '@clinmesh/ui/appearance'
import { create } from 'zustand'

export interface RecentVisit {
  path: string
  space: AppSpaceId
  labelZh: string
  labelEn: string
}

interface SpaceNavigationState {
  /** Last visited URL per top-level space so switching spaces restores context. */
  spaceLastUrls: Partial<Record<AppSpaceId, string>>
  /** Last non-settings URL visited, powering Settings "← Back to app". */
  lastNonSettingsPath: string | null
  /** Recent visited routes for Command Palette quick recall (max 5). */
  recentVisits: readonly RecentVisit[]
  recordVisit: (visit: RecentVisit) => void
}

const MAX_RECENT = 5

export const useSpaceNavigationStore = create<SpaceNavigationState>(set => ({
  spaceLastUrls: {},
  lastNonSettingsPath: null,
  recentVisits: [],
  recordVisit: visit => {
    set(state => {
      const nextSpaceLastUrls: Partial<Record<AppSpaceId, string>> = {
        ...state.spaceLastUrls,
        [visit.space]: visit.path,
      }
      const nextLastNonSettings =
        visit.space !== 'settings' ? visit.path : state.lastNonSettingsPath
      const deduped = state.recentVisits.filter(item => item.path !== visit.path)
      const nextRecent = [visit, ...deduped].slice(0, MAX_RECENT)
      return {
        spaceLastUrls: nextSpaceLastUrls,
        lastNonSettingsPath: nextLastNonSettings,
        recentVisits: nextRecent,
      }
    })
  },
}))
