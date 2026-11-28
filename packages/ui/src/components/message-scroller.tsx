"use client"

import * as React from "react"
import {
  mergeProps,
  renderElement,
  type RenderProp,
} from "@ui-sdk/react/primitive"
import { ArrowDownIcon } from "lucide-react"

import { Button } from "#components/button"
import { cn } from "#lib/utils"

type MessageScrollerDefaultScrollPosition = "start" | "end" | "last-anchor"
type MessageScrollerButtonDirection = "start" | "end"
type MessageScrollerScrollAlign = "start" | "center" | "end" | "nearest"

type MessageScrollerScrollOptions = {
  align?: MessageScrollerScrollAlign | undefined
  behavior?: ScrollBehavior | undefined
  scrollMargin?: number | undefined
}

type MessageScrollerScrollable = {
  start: boolean
  end: boolean
}

type MessageScrollerVisibilityState = {
  currentAnchorId: string | null
  visibleMessageIds: string[]
}

type MessageScrollerProviderProps = {
  children?: React.ReactNode
  autoScroll?: boolean | undefined
  defaultScrollPosition?: MessageScrollerDefaultScrollPosition | undefined
  scrollEdgeThreshold?: number | undefined
  scrollPreviousItemPeek?: number | undefined
  scrollMargin?: number | undefined
}

type MessageScrollerButtonRenderState = {
  active: boolean
  direction: MessageScrollerButtonDirection
}

type ExternalStore<T> = {
  getSnapshot: () => T
  hasListeners: () => boolean
  setSnapshot: (next: T) => void
  subscribe: (
    listener: () => void,
    onFirst?: () => void,
    onEmpty?: () => void
  ) => () => void
}

const DEFAULT_EDGE_THRESHOLD = 8
const DEFAULT_PREVIOUS_ITEM_PEEK = 64
const SUBPIXEL_EPSILON = 0.5
const AUTOSCROLL_CLEAR_MS = 180
const SCROLL_KEYS = new Set([
  "ArrowDown",
  "ArrowUp",
  "End",
  "Home",
  "PageDown",
  "PageUp",
  " ",
])
const EMPTY_SCROLLABLE: MessageScrollerScrollable = { start: false, end: false }
const EMPTY_IDS: string[] = []
const EMPTY_VISIBILITY: MessageScrollerVisibilityState = {
  currentAnchorId: null,
  visibleMessageIds: EMPTY_IDS,
}

function createStore<T>(
  initial: T,
  equals: (a: T, b: T) => boolean
): ExternalStore<T> {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    hasListeners: () => listeners.size > 0,
    setSnapshot(next: T) {
      if (equals(snapshot, next)) return
      snapshot = next
      listeners.forEach((listener) => listener())
    },
    subscribe(listener, onFirst, onEmpty) {
      const first = listeners.size === 0
      listeners.add(listener)
      if (first) onFirst?.()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) onEmpty?.()
      }
    },
  }
}

function sameScrollable(
  a: MessageScrollerScrollable,
  b: MessageScrollerScrollable
): boolean {
  return a.start === b.start && a.end === b.end
}

function sameVisibility(
  a: MessageScrollerVisibilityState,
  b: MessageScrollerVisibilityState
): boolean {
  return (
    a.currentAnchorId === b.currentAnchorId &&
    a.visibleMessageIds.length === b.visibleMessageIds.length &&
    a.visibleMessageIds.every((id, index) => id === b.visibleMessageIds[index])
  )
}

function parsePx(value: string): number {
  if (!value) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function blockPadding(element: HTMLElement): { start: number; end: number } {
  const style = window.getComputedStyle(element)
  return {
    start: parsePx(style.paddingBlockStart || style.paddingTop),
    end: parsePx(style.paddingBlockEnd || style.paddingBottom),
  }
}

function rowGapOf(element: HTMLElement | null): number {
  if (!element) return 0
  const style = window.getComputedStyle(element)
  return parsePx(style.rowGap === "normal" ? style.gap : style.rowGap)
}

function contentItems(
  content: HTMLElement,
  spacer: HTMLElement | null
): HTMLElement[] {
  return Array.from(content.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child !== spacer
  )
}

function contentHeightWithoutSpacer(
  content: HTMLElement,
  spacer: HTMLElement | null,
  viewport: HTMLElement
): number {
  const items = contentItems(content, spacer)
  const padding = blockPadding(content)
  const viewportRect = viewport.getBoundingClientRect()
  let maxBottom = padding.start + padding.end
  for (const item of items) {
    const rect = item.getBoundingClientRect()
    maxBottom = Math.max(
      maxBottom,
      rect.bottom - viewportRect.top + viewport.scrollTop + padding.end
    )
  }
  return maxBottom
}

function measureScrollable(
  content: HTMLElement | null,
  spacer: HTMLElement | null,
  viewport: HTMLElement | null,
  threshold: number
): MessageScrollerScrollable {
  if (!viewport || !content) return EMPTY_SCROLLABLE
  const totalHeight = contentHeightWithoutSpacer(content, spacer, viewport)
  return {
    start: viewport.scrollTop > threshold,
    end: totalHeight - viewport.scrollTop - viewport.clientHeight > threshold,
  }
}

function measureVisibility(
  content: HTMLElement | null,
  spacer: HTMLElement | null,
  viewport: HTMLElement | null,
  scrollMargin: number,
  previousItemPeek: number,
  visibleSet: Set<string>
): MessageScrollerVisibilityState {
  if (!content || !viewport) return EMPTY_VISIBILITY
  const viewportRect = viewport.getBoundingClientRect()
  const anchorEdge = viewportRect.top + scrollMargin + previousItemPeek
  const fallbackRectCheck = typeof IntersectionObserver === "undefined"
  const visibleMessageIds: string[] = []
  let currentAnchorId: string | null = null

  for (const child of contentItems(content, spacer)) {
    const id = child.dataset["messageId"]
    if (!id) continue
    const isAnchor = child.dataset["scrollAnchor"] === "true"
    const rect =
      isAnchor || fallbackRectCheck ? child.getBoundingClientRect() : null
    if (
      fallbackRectCheck && rect
        ? rect.bottom > anchorEdge && rect.top < viewportRect.bottom
        : visibleSet.has(id)
    ) {
      visibleMessageIds.push(id)
    }
    if (isAnchor && rect && rect.top <= anchorEdge + SUBPIXEL_EPSILON) {
      currentAnchorId = id
    }
  }

  if (visibleMessageIds.length === 0 && currentAnchorId === null) {
    return EMPTY_VISIBILITY
  }
  return { currentAnchorId, visibleMessageIds }
}

function assignRef<T>(ref: React.Ref<T> | undefined, value: T | null): void {
  if (typeof ref === "function") {
    ref(value)
  } else if (ref && "current" in ref) {
    ;(ref as React.MutableRefObject<T | null>).current = value
  }
}

type MessageScrollerContextValue = {
  handleContentChange: () => void
  handleResize: () => void
  observeVisibility: () => void
  preserveScrollOnPrependRef: React.MutableRefObject<boolean>
  scrollToEnd: (options?: MessageScrollerScrollOptions) => boolean
  scrollToMessage: (
    messageId: string,
    options?: MessageScrollerScrollOptions
  ) => boolean
  scrollToStart: (options?: MessageScrollerScrollOptions) => boolean
  setContentElement: (el: HTMLElement | null) => void
  setRootElement: (el: HTMLElement | null) => void
  setSpacerElement: (el: HTMLElement | null) => void
  setViewportElement: (el: HTMLElement | null) => void
  stateStore: ExternalStore<MessageScrollerScrollable>
  syncAfterScroll: () => void
  unobserveVisibility: () => void
  userScrollIntent: () => void
  viewportRef: React.MutableRefObject<HTMLElement | null>
  visibilityStore: ExternalStore<MessageScrollerVisibilityState>
}

type RegisterMessage = (
  messageId: string,
  el: HTMLElement | null,
  previousEl: HTMLElement | null
) => void

const MessageScrollerContext =
  React.createContext<MessageScrollerContextValue | null>(null)
const MessageScrollerRegisterContext =
  React.createContext<RegisterMessage | null>(null)

function useMessageScrollerContext(): MessageScrollerContextValue {
  const ctx = React.useContext(MessageScrollerContext)
  if (!ctx) {
    throw new Error("useMessageScroller must be used within a MessageScroller.")
  }
  return ctx
}

function useMessageScroller() {
  const { scrollToEnd, scrollToMessage, scrollToStart } =
    useMessageScrollerContext()
  return React.useMemo(
    () => ({ scrollToEnd, scrollToMessage, scrollToStart }),
    [scrollToEnd, scrollToMessage, scrollToStart]
  )
}

function useMessageScrollerScrollable(): MessageScrollerScrollable {
  const { stateStore } = useMessageScrollerContext()
  return React.useSyncExternalStore(
    stateStore.subscribe,
    stateStore.getSnapshot,
    stateStore.getSnapshot
  )
}

function useMessageScrollerVisibility(): MessageScrollerVisibilityState {
  const { observeVisibility, unobserveVisibility, visibilityStore } =
    useMessageScrollerContext()
  const subscribe = React.useCallback(
    (listener: () => void) =>
      visibilityStore.subscribe(
        listener,
        observeVisibility,
        unobserveVisibility
      ),
    [observeVisibility, unobserveVisibility, visibilityStore]
  )
  return React.useSyncExternalStore(
    subscribe,
    visibilityStore.getSnapshot,
    visibilityStore.getSnapshot
  )
}

function MessageScrollerProvider({
  autoScroll = false,
  children,
  defaultScrollPosition = "end",
  scrollEdgeThreshold = DEFAULT_EDGE_THRESHOLD,
  scrollPreviousItemPeek = DEFAULT_PREVIOUS_ITEM_PEEK,
  scrollMargin = 0,
}: MessageScrollerProviderProps) {
  const rootRef = React.useRef<HTMLElement | null>(null)
  const viewportRef = React.useRef<HTMLElement | null>(null)
  const contentRef = React.useRef<HTMLElement | null>(null)
  const spacerRef = React.useRef<HTMLElement | null>(null)

  const autoScrollRef = React.useRef(autoScroll)
  const thresholdRef = React.useRef(scrollEdgeThreshold)
  const marginRef = React.useRef(scrollMargin)
  const peekRef = React.useRef(scrollPreviousItemPeek)
  autoScrollRef.current = autoScroll
  thresholdRef.current = scrollEdgeThreshold
  marginRef.current = scrollMargin
  peekRef.current = scrollPreviousItemPeek

  const defaultAppliedRef = React.useRef(false)
  const defaultPositionRef = React.useRef(defaultScrollPosition)
  if (defaultPositionRef.current !== defaultScrollPosition) {
    defaultPositionRef.current = defaultScrollPosition
    defaultAppliedRef.current = false
  }

  const modeRef = React.useRef<
    "following-bottom" | "free-scrolling" | "anchored-to-message" | "settling-jump"
  >(autoScroll ? "following-bottom" : "free-scrolling")
  const autoscrollingRef = React.useRef(false)
  const autoscrollTimerRef = React.useRef<number | null>(null)
  const stateFrameRef = React.useRef<number | null>(null)
  const visibilityFrameRef = React.useRef<number | null>(null)
  const pendingScrollFrameRef = React.useRef<number | null>(null)
  const lastScrollTopRef = React.useRef(0)
  const itemCountRef = React.useRef(0)
  const firstItemRef = React.useRef<HTMLElement | null>(null)
  const spacerGapRef = React.useRef(0)
  const spacerHeightRef = React.useRef(0)
  const anchoredRef = React.useRef<HTMLElement | null>(null)
  const prependRestoreRef = React.useRef<{
    element: HTMLElement
    viewportTop: number
  } | null>(null)
  const preserveScrollOnPrependRef = React.useRef(true)
  const pendingScrollRef = React.useRef<{
    messageId: string
    options?: MessageScrollerScrollOptions | undefined
  } | null>(null)
  const messageElementsRef = React.useRef(new Map<string, HTMLElement>())
  const visibleMessageIdsRef = React.useRef(new Set<string>())
  const visibilityObserverRef = React.useRef<IntersectionObserver | null>(null)
  const handledAnchorsRef = React.useRef(new WeakSet<HTMLElement>())

  const stateStoreRef = React.useRef<ExternalStore<MessageScrollerScrollable> | null>(
    null
  )
  stateStoreRef.current ??= createStore(EMPTY_SCROLLABLE, sameScrollable)
  const stateStore = stateStoreRef.current

  const visibilityStoreRef =
    React.useRef<ExternalStore<MessageScrollerVisibilityState> | null>(null)
  visibilityStoreRef.current ??= createStore(EMPTY_VISIBILITY, sameVisibility)
  const visibilityStore = visibilityStoreRef.current

  const syncDomAttributes = React.useCallback(
    (scrollable: MessageScrollerScrollable) => {
      const value = [scrollable.start && "start", scrollable.end && "end"]
        .filter(Boolean)
        .join(" ")
      const autoscrolling = autoscrollingRef.current
      for (const el of [rootRef.current, viewportRef.current]) {
        if (!el) continue
        if (value) el.setAttribute("data-scrollable", value)
        else el.removeAttribute("data-scrollable")
        el.toggleAttribute("data-autoscrolling", autoscrolling)
      }
    },
    []
  )

  const commitScrollState = React.useCallback(() => {
    const measured = measureScrollable(
      contentRef.current,
      spacerRef.current,
      viewportRef.current,
      thresholdRef.current
    )
    const currentTop = viewportRef.current?.scrollTop ?? 0
    const scrolledUp = currentTop < lastScrollTopRef.current - SUBPIXEL_EPSILON
    lastScrollTopRef.current = currentTop

    if (
      autoScrollRef.current &&
      !measured.end &&
      modeRef.current !== "settling-jump" &&
      modeRef.current !== "anchored-to-message"
    ) {
      modeRef.current = "following-bottom"
    } else if (
      modeRef.current === "following-bottom" &&
      measured.end &&
      scrolledUp &&
      !autoscrollingRef.current
    ) {
      modeRef.current = "free-scrolling"
    }

    const effective =
      modeRef.current === "following-bottom"
        ? { ...measured, end: false }
        : measured
    syncDomAttributes(effective)
    stateStore.setSnapshot(effective)
  }, [stateStore, syncDomAttributes])

  const scheduleStateCommit = React.useCallback(() => {
    if (stateFrameRef.current !== null) return
    stateFrameRef.current = window.requestAnimationFrame(() => {
      stateFrameRef.current = null
      commitScrollState()
    })
  }, [commitScrollState])

  const scheduleVisibilitySync = React.useCallback(() => {
    if (!visibilityStore.hasListeners() || visibilityFrameRef.current !== null) {
      return
    }
    visibilityFrameRef.current = window.requestAnimationFrame(() => {
      visibilityFrameRef.current = null
      if (!visibilityStore.hasListeners()) return
      visibilityStore.setSnapshot(
        measureVisibility(
          contentRef.current,
          spacerRef.current,
          viewportRef.current,
          marginRef.current,
          peekRef.current,
          visibleMessageIdsRef.current
        )
      )
    })
  }, [visibilityStore])

  const setAutoscrolling = React.useCallback(
    (active: boolean) => {
      if (autoscrollTimerRef.current !== null) {
        window.clearTimeout(autoscrollTimerRef.current)
        autoscrollTimerRef.current = null
      }
      if (autoscrollingRef.current !== active) {
        autoscrollingRef.current = active
        commitScrollState()
      }
      if (active) {
        autoscrollTimerRef.current = window.setTimeout(() => {
          autoscrollTimerRef.current = null
          autoscrollingRef.current = false
          commitScrollState()
        }, AUTOSCROLL_CLEAR_MS)
      }
    },
    [commitScrollState]
  )

  const setSpacerHeight = React.useCallback((rawHeight: number) => {
    const spacer = spacerRef.current
    if (!spacer) return
    const nextHeight = Math.max(0, Math.ceil(rawHeight))
    if (spacerHeightRef.current === nextHeight) return
    spacerHeightRef.current = nextHeight
    spacer.hidden = nextHeight === 0
    spacer.style.height = `${nextHeight}px`
    spacer.style.marginTop = nextHeight > 0 ? `${-spacerGapRef.current}px` : ""
  }, [])

  const applyScrollTop = React.useCallback(
    (
      top: number,
      {
        behavior = "auto",
        autoscrolling = false,
      }: { behavior?: ScrollBehavior; autoscrolling?: boolean } = {}
    ) => {
      const viewport = viewportRef.current
      if (!viewport) return
      const targetTop = Math.max(0, top)
      if (Math.abs(viewport.scrollTop - targetTop) <= SUBPIXEL_EPSILON) {
        viewport.scrollTop = targetTop
        commitScrollState()
        return
      }
      if (autoscrolling) setAutoscrolling(true)
      viewport.scrollTo({ top: targetTop, behavior })
      scheduleStateCommit()
    },
    [commitScrollState, scheduleStateCommit, setAutoscrolling]
  )

  const scrollToStart = React.useCallback(
    ({ behavior = "auto" }: MessageScrollerScrollOptions = {}) => {
      if (!viewportRef.current) return false
      setSpacerHeight(0)
      anchoredRef.current = null
      modeRef.current = "free-scrolling"
      applyScrollTop(0, { behavior })
      scheduleVisibilitySync()
      return true
    },
    [applyScrollTop, scheduleVisibilitySync, setSpacerHeight]
  )

  const scrollToEnd = React.useCallback(
    ({ behavior = "auto" }: MessageScrollerScrollOptions = {}) => {
      const viewport = viewportRef.current
      if (!viewport) return false
      setSpacerHeight(0)
      anchoredRef.current = null
      modeRef.current = autoScrollRef.current
        ? "following-bottom"
        : "free-scrolling"
      applyScrollTop(Math.max(0, viewport.scrollHeight - viewport.clientHeight), {
        behavior,
        autoscrolling: true,
      })
      scheduleVisibilitySync()
      return true
    },
    [applyScrollTop, scheduleVisibilitySync, setSpacerHeight]
  )

  const scrollToElement = React.useCallback(
    (
      element: HTMLElement,
      {
        align = "start",
        behavior = "auto",
        scrollMargin: customMargin = marginRef.current,
      }: MessageScrollerScrollOptions = {},
      { keepPreviousPeek = false } = {}
    ) => {
      const content = contentRef.current
      const viewport = viewportRef.current
      if (!content || !viewport || !content.contains(element)) return false

      const elemRect = element.getBoundingClientRect()
      const viewportRect = viewport.getBoundingClientRect()
      const elemTopInScroll = elemRect.top - viewportRect.top + viewport.scrollTop
      const padding = spacerRef.current?.parentElement
        ? blockPadding(spacerRef.current.parentElement)
        : { start: 0, end: 0 }
      const effectiveMargin = keepPreviousPeek
        ? customMargin + peekRef.current
        : customMargin

      let targetTop: number
      if (align === "center") {
        const inner = Math.max(
          0,
          viewport.clientHeight - padding.start - padding.end
        )
        targetTop =
          elemTopInScroll -
          padding.start -
          (inner - elemRect.height) / 2 -
          effectiveMargin
      } else if (align === "end") {
        targetTop =
          elemTopInScroll -
          viewport.clientHeight +
          elemRect.height +
          padding.end +
          effectiveMargin
      } else if (align === "nearest") {
        const elemBottom = elemTopInScroll + elemRect.height
        const viewStart = viewport.scrollTop + padding.start
        const viewEnd = viewport.scrollTop + viewport.clientHeight - padding.end
        targetTop =
          elemTopInScroll >= viewStart && elemBottom <= viewEnd
            ? viewport.scrollTop
            : elemTopInScroll < viewStart
              ? elemTopInScroll - padding.start - effectiveMargin
              : elemBottom - viewport.clientHeight + padding.end + effectiveMargin
      } else {
        targetTop = elemTopInScroll - padding.start - effectiveMargin
      }

      const contentHeight = contentHeightWithoutSpacer(
        content,
        spacerRef.current,
        viewport
      )
      setSpacerHeight(targetTop + viewport.clientHeight - contentHeight)
      prependRestoreRef.current = {
        element,
        viewportTop: elemRect.top - viewportRect.top,
      }
      modeRef.current = keepPreviousPeek
        ? "anchored-to-message"
        : "settling-jump"
      anchoredRef.current = keepPreviousPeek ? element : null
      applyScrollTop(targetTop, { behavior })
      scheduleVisibilitySync()
      return true
    },
    [applyScrollTop, scheduleVisibilitySync, setSpacerHeight]
  )

  const scrollToMessage = React.useCallback(
    (messageId: string, options?: MessageScrollerScrollOptions) => {
      const target = messageElementsRef.current.get(messageId)
      if (target) {
        defaultAppliedRef.current = true
        if (scrollToElement(target, options)) {
          pendingScrollRef.current = null
          return true
        }
        pendingScrollRef.current = { messageId, options }
        return true
      }
      if (itemCountRef.current === 0) {
        pendingScrollRef.current = { messageId, options }
        defaultAppliedRef.current = true
        return true
      }
      return false
    },
    [scrollToElement]
  )

  const flushPendingScroll = React.useCallback(() => {
    const pending = pendingScrollRef.current
    if (!pending) return false
    const target = messageElementsRef.current.get(pending.messageId)
    if (!target || !scrollToElement(target, pending.options)) return false
    pendingScrollRef.current = null
    defaultAppliedRef.current = true
    return true
  }, [scrollToElement])

  const captureFirstVisible = React.useCallback(() => {
    const content = contentRef.current
    const viewport = viewportRef.current
    if (!content || !viewport) {
      prependRestoreRef.current = null
      return
    }
    const viewportRect = viewport.getBoundingClientRect()
    let found: HTMLElement | null = null
    for (const child of contentItems(content, spacerRef.current)) {
      if (!child.dataset["messageId"]) continue
      const rect = child.getBoundingClientRect()
      if (rect.bottom > viewportRect.top && rect.top < viewportRect.bottom) {
        found = child
        break
      }
    }
    prependRestoreRef.current = found
      ? {
          element: found,
          viewportTop: found.getBoundingClientRect().top - viewportRect.top,
        }
      : null
  }, [])

  const applyDefaultScrollPosition = React.useCallback(() => {
    if (
      !defaultScrollPosition ||
      defaultAppliedRef.current ||
      itemCountRef.current === 0
    ) {
      return false
    }
    let applied = false
    if (defaultScrollPosition === "last-anchor") {
      const content = contentRef.current
      const viewport = viewportRef.current
      const items = content ? contentItems(content, spacerRef.current) : []
      let lastAnchor: HTMLElement | null = null
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i]?.dataset["scrollAnchor"] === "true") {
          lastAnchor = items[i] ?? null
          break
        }
      }
      if (!content || !viewport || !lastAnchor) {
        applied = scrollToEnd({ behavior: "auto" })
      } else {
        const anchorTop =
          lastAnchor.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top +
          viewport.scrollTop
        const total = contentHeightWithoutSpacer(
          content,
          spacerRef.current,
          viewport
        )
        applied =
          total - anchorTop <= viewport.clientHeight
            ? scrollToEnd({ behavior: "auto" })
            : scrollToElement(
                lastAnchor,
                { align: "start" },
                { keepPreviousPeek: true }
              )
      }
    } else {
      applied =
        defaultScrollPosition === "end"
          ? scrollToEnd({ behavior: "auto" })
          : scrollToStart({ behavior: "auto" })
    }
    if (!applied) return false
    defaultAppliedRef.current = true
    return true
  }, [defaultScrollPosition, scrollToElement, scrollToEnd, scrollToStart])

  const handleContentChange = React.useCallback(() => {
    const content = contentRef.current
    if (!content) return
    const items = contentItems(content, spacerRef.current)
    const prevCount = itemCountRef.current
    const prevFirst = firstItemRef.current
    itemCountRef.current = items.length
    firstItemRef.current = items[0] ?? null

    const update = () => {
      if (flushPendingScroll()) return
      if (prevCount === 0) {
        if (
          applyDefaultScrollPosition() ||
          (items.length > 0 &&
            autoScrollRef.current &&
            scrollToEnd({ behavior: "auto" }))
        ) {
          return
        }
        commitScrollState()
        scheduleVisibilitySync()
        return
      }
      const prevFirstIdx = prevFirst ? items.indexOf(prevFirst) : -1
      if (preserveScrollOnPrependRef.current && prevFirstIdx > 0) {
        const restore = prependRestoreRef.current
        const viewport = viewportRef.current
        if (restore && viewport && restore.element.isConnected) {
          const delta =
            restore.element.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            restore.viewportTop
          if (Math.abs(delta) > SUBPIXEL_EPSILON) {
            viewport.scrollTop += delta
            restore.viewportTop =
              restore.element.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top
            scheduleStateCommit()
            scheduleVisibilitySync()
          }
        }
        return
      }
      if (items.length > prevCount) {
        const addedAnchor = items
          .slice(prevCount)
          .find((el) => el.dataset["scrollAnchor"] === "true")
        if (addedAnchor) {
          const multipleAddedAnchors =
            items
              .slice(prevCount)
              .filter((el) => el.dataset["scrollAnchor"] === "true").length > 1
          if (
            autoScrollRef.current &&
            modeRef.current === "following-bottom" &&
            multipleAddedAnchors
          ) {
            scrollToEnd({ behavior: "auto" })
            return
          }
          scrollToElement(
            addedAnchor,
            { align: "start" },
            { keepPreviousPeek: true }
          )
          handledAnchorsRef.current.add(addedAnchor)
          return
        }
      }
      if (items.length === prevCount) {
        const newAnchor = items.find(
          (el) =>
            el.dataset["scrollAnchor"] === "true" &&
            !handledAnchorsRef.current.has(el)
        )
        if (newAnchor) {
          scrollToElement(
            newAnchor,
            { align: "start" },
            { keepPreviousPeek: true }
          )
          handledAnchorsRef.current.add(newAnchor)
          return
        }
      }
      if (modeRef.current === "following-bottom" && autoScrollRef.current) {
        scrollToEnd({ behavior: "auto" })
      } else {
        commitScrollState()
        scheduleVisibilitySync()
      }
    }

    update()
    captureFirstVisible()
  }, [
    applyDefaultScrollPosition,
    captureFirstVisible,
    commitScrollState,
    flushPendingScroll,
    scheduleStateCommit,
    scheduleVisibilitySync,
    scrollToElement,
    scrollToEnd,
  ])

  const handleResize = React.useCallback(() => {
    if (modeRef.current === "following-bottom" && autoScrollRef.current) {
      scrollToEnd({ behavior: "auto" })
      return
    }
    const prevSpacer = spacerHeightRef.current
    const anchored = anchoredRef.current
    if (
      anchored &&
      anchored.isConnected &&
      modeRef.current === "anchored-to-message" &&
      scrollToElement(anchored, { align: "start" }, { keepPreviousPeek: true })
    ) {
      if (
        autoScrollRef.current &&
        prevSpacer > 0 &&
        spacerHeightRef.current === 0
      ) {
        scrollToEnd({ behavior: "auto" })
      }
      return
    }
    scheduleStateCommit()
    scheduleVisibilitySync()
  }, [scheduleStateCommit, scheduleVisibilitySync, scrollToElement, scrollToEnd])

  const observeVisibility = React.useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport || !visibilityStore.hasListeners()) return
    if (typeof IntersectionObserver === "undefined") {
      scheduleVisibilitySync()
      return
    }
    if (!visibilityObserverRef.current) {
      visibilityObserverRef.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = (entry.target as HTMLElement).dataset["messageId"]
            if (!id) continue
            if (entry.isIntersecting) visibleMessageIdsRef.current.add(id)
            else visibleMessageIdsRef.current.delete(id)
          }
          scheduleVisibilitySync()
        },
        {
          root: viewport,
          rootMargin: `${-(marginRef.current + peekRef.current)}px 0px 0px 0px`,
          threshold: [0, 0.01, 0.5, 1],
        }
      )
    }
    messageElementsRef.current.forEach((el) => {
      visibilityObserverRef.current?.observe(el)
    })
    scheduleVisibilitySync()
  }, [scheduleVisibilitySync, visibilityStore])

  const unobserveVisibility = React.useCallback(() => {
    if (visibilityFrameRef.current !== null) {
      window.cancelAnimationFrame(visibilityFrameRef.current)
      visibilityFrameRef.current = null
    }
    visibilityObserverRef.current?.disconnect()
    visibilityObserverRef.current = null
    visibleMessageIdsRef.current.clear()
    visibilityStore.setSnapshot(EMPTY_VISIBILITY)
  }, [visibilityStore])

  const registerMessage = React.useCallback<RegisterMessage>(
    (messageId, el, previousEl) => {
      if (el) {
        messageElementsRef.current.set(messageId, el)
        visibilityObserverRef.current?.observe(el)
        scheduleVisibilitySync()
        if (pendingScrollRef.current?.messageId === messageId) {
          if (pendingScrollFrameRef.current === null) {
            pendingScrollFrameRef.current = window.requestAnimationFrame(() => {
              pendingScrollFrameRef.current = null
              if (flushPendingScroll()) captureFirstVisible()
            })
          }
        }
        return
      }
      if (previousEl && messageElementsRef.current.get(messageId) === previousEl) {
        messageElementsRef.current.delete(messageId)
        visibleMessageIdsRef.current.delete(messageId)
        visibilityObserverRef.current?.unobserve(previousEl)
        scheduleVisibilitySync()
      }
    },
    [captureFirstVisible, flushPendingScroll, scheduleVisibilitySync]
  )

  const userScrollIntent = React.useCallback(() => {
    if (
      modeRef.current === "following-bottom" ||
      modeRef.current === "anchored-to-message" ||
      modeRef.current === "settling-jump"
    ) {
      anchoredRef.current = null
      modeRef.current = "free-scrolling"
    }
  }, [])

  const syncAfterScroll = React.useCallback(() => {
    commitScrollState()
    scheduleVisibilitySync()
    captureFirstVisible()
  }, [captureFirstVisible, commitScrollState, scheduleVisibilitySync])

  const setRootElement = React.useCallback(
    (el: HTMLElement | null) => {
      rootRef.current = el
      if (el) syncDomAttributes(stateStore.getSnapshot())
    },
    [stateStore, syncDomAttributes]
  )

  const setViewportElement = React.useCallback(
    (el: HTMLElement | null) => {
      viewportRef.current = el
      if (el) syncDomAttributes(stateStore.getSnapshot())
    },
    [stateStore, syncDomAttributes]
  )

  const setContentElement = React.useCallback((el: HTMLElement | null) => {
    contentRef.current = el
  }, [])

  const setSpacerElement = React.useCallback((el: HTMLElement | null) => {
    spacerRef.current = el
    spacerGapRef.current = rowGapOf(el?.parentElement ?? null)
  }, [])

  React.useLayoutEffect(() => {
    applyDefaultScrollPosition()
  }, [applyDefaultScrollPosition])

  React.useLayoutEffect(() => {
    if (
      autoScroll &&
      modeRef.current === "following-bottom" &&
      itemCountRef.current > 0
    ) {
      scrollToEnd({ behavior: "auto" })
      return
    }
    commitScrollState()
  }, [autoScroll, commitScrollState, scrollToEnd])

  React.useEffect(() => {
    return () => {
      if (stateFrameRef.current !== null) {
        window.cancelAnimationFrame(stateFrameRef.current)
        stateFrameRef.current = null
      }
      if (visibilityFrameRef.current !== null) {
        window.cancelAnimationFrame(visibilityFrameRef.current)
        visibilityFrameRef.current = null
      }
      if (autoscrollTimerRef.current !== null) {
        window.clearTimeout(autoscrollTimerRef.current)
        autoscrollTimerRef.current = null
      }
      if (pendingScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(pendingScrollFrameRef.current)
        pendingScrollFrameRef.current = null
      }
      visibilityObserverRef.current?.disconnect()
      visibilityObserverRef.current = null
    }
  }, [])

  const contextValue = React.useMemo<MessageScrollerContextValue>(
    () => ({
      handleContentChange,
      handleResize,
      observeVisibility,
      preserveScrollOnPrependRef,
      scrollToEnd,
      scrollToMessage,
      scrollToStart,
      setContentElement,
      setRootElement,
      setSpacerElement,
      setViewportElement,
      stateStore,
      syncAfterScroll,
      unobserveVisibility,
      userScrollIntent,
      viewportRef,
      visibilityStore,
    }),
    [
      handleContentChange,
      handleResize,
      observeVisibility,
      scrollToEnd,
      scrollToMessage,
      scrollToStart,
      setContentElement,
      setRootElement,
      setSpacerElement,
      setViewportElement,
      stateStore,
      syncAfterScroll,
      unobserveVisibility,
      userScrollIntent,
      visibilityStore,
    ]
  )

  return (
    <MessageScrollerContext.Provider value={contextValue}>
      <MessageScrollerRegisterContext.Provider value={registerMessage}>
        {children}
      </MessageScrollerRegisterContext.Provider>
    </MessageScrollerContext.Provider>
  )
}

function MessageScroller({
  className,
  children,
  ...props
}: React.ComponentProps<"div">) {
  const { setRootElement } = useMessageScrollerContext()
  return (
    <div
      ref={setRootElement}
      data-slot="message-scroller"
      className={cn(
        "group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

function MessageScrollerViewport({
  "aria-label": ariaLabel,
  className,
  children,
  onKeyDown,
  onScroll,
  onTouchMove,
  onWheel,
  preserveScrollOnPrepend = true,
  ref,
  role,
  tabIndex,
  ...props
}: React.ComponentProps<"div"> & {
  preserveScrollOnPrepend?: boolean | undefined
}) {
  const {
    handleResize,
    preserveScrollOnPrependRef,
    setViewportElement,
    syncAfterScroll,
    userScrollIntent,
    viewportRef,
  } = useMessageScrollerContext()
  preserveScrollOnPrependRef.current = preserveScrollOnPrepend

  const mergedRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      setViewportElement(node)
      assignRef(ref, node)
    },
    [ref, setViewportElement]
  )

  React.useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver === "undefined") return
    let frame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(handleResize)
    })
    observer.observe(viewport)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [handleResize, viewportRef])

  return (
    <div
      ref={mergedRef}
      data-slot="message-scroller-viewport"
      role={role ?? "region"}
      aria-label={ariaLabel ?? "Messages"}
      tabIndex={tabIndex ?? 0}
      className={cn(
        "size-full min-h-0 min-w-0 scroll-fade-b scrollbar-thin scrollbar-gutter-stable overflow-y-auto overscroll-contain contain-content data-autoscrolling:scrollbar-thumb-transparent data-autoscrolling:scrollbar-track-transparent",
        className
      )}
      onKeyDown={(event) => {
        if (SCROLL_KEYS.has(event.key)) userScrollIntent()
        onKeyDown?.(event)
      }}
      onScroll={(event) => {
        syncAfterScroll()
        onScroll?.(event)
      }}
      onTouchMove={(event) => {
        userScrollIntent()
        onTouchMove?.(event)
      }}
      onWheel={(event) => {
        userScrollIntent()
        onWheel?.(event)
      }}
      {...props}
    >
      {children}
    </div>
  )
}

function MessageScrollerContent({
  "aria-relevant": ariaRelevant,
  className,
  children,
  ref,
  role,
  spacerClassName,
  ...props
}: React.ComponentProps<"div"> & {
  spacerClassName?: string | undefined
}) {
  const {
    handleContentChange,
    handleResize,
    setContentElement,
    setSpacerElement,
  } = useMessageScrollerContext()
  const localRef = React.useRef<HTMLDivElement | null>(null)
  const mergedRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      localRef.current = node
      setContentElement(node)
      assignRef(ref, node)
    },
    [ref, setContentElement]
  )

  React.useLayoutEffect(() => {
    const node = localRef.current
    if (!node) return
    handleContentChange()
    if (typeof MutationObserver === "undefined") return
    const observer = new MutationObserver(() => {
      handleContentChange()
    })
    observer.observe(node, { childList: true })
    return () => observer.disconnect()
  }, [handleContentChange])

  React.useEffect(() => {
    const node = localRef.current
    if (!node || typeof ResizeObserver === "undefined") return
    let frame = 0
    const observer = new ResizeObserver(() => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(handleResize)
    })
    observer.observe(node)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [handleResize])

  return (
    <div
      ref={mergedRef}
      data-slot="message-scroller-content"
      role={role ?? "log"}
      aria-relevant={ariaRelevant ?? "additions"}
      className={cn("flex h-max min-h-full flex-col gap-6", className)}
      {...props}
    >
      {children}
      <div
        ref={setSpacerElement}
        aria-hidden="true"
        data-message-scroller-spacer=""
        hidden
        className={spacerClassName}
      />
    </div>
  )
}

function MessageScrollerItem({
  className,
  messageId,
  ref,
  scrollAnchor = false,
  ...props
}: React.ComponentProps<"div"> & {
  messageId?: string | undefined
  scrollAnchor?: boolean | undefined
}) {
  const registerMessage = React.useContext(MessageScrollerRegisterContext)
  if (!registerMessage) {
    throw new Error(
      "MessageScrollerItem must be used within a MessageScroller."
    )
  }
  const previousRef = React.useRef<HTMLDivElement | null>(null)
  const mergedRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      const prev = previousRef.current
      previousRef.current = node
      if (messageId) registerMessage(messageId, node, prev)
      assignRef(ref, node)
    },
    [messageId, ref, registerMessage]
  )

  return (
    <div
      ref={mergedRef}
      data-slot="message-scroller-item"
      data-message-id={messageId}
      data-scroll-anchor={scrollAnchor ? "true" : "false"}
      className={cn(
        "min-w-0 shrink-0 [contain-intrinsic-size:auto_10rem] [content-visibility:auto]",
        className
      )}
      {...props}
    />
  )
}

function MessageScrollerButton({
  behavior = "smooth",
  direction = "end",
  className,
  children,
  onClick,
  render,
  tabIndex,
  type = "button",
  variant = "secondary",
  size = "icon-sm",
  ...props
}: React.ComponentProps<"button"> &
  Pick<React.ComponentProps<typeof Button>, "variant" | "size"> & {
    behavior?: ScrollBehavior | undefined
    direction?: MessageScrollerButtonDirection | undefined
    render?: RenderProp<MessageScrollerButtonRenderState> | undefined
  }) {
  const { scrollToEnd, scrollToStart, stateStore } =
    useMessageScrollerContext()
  const onClickRef = React.useRef(onClick)
  onClickRef.current = onClick

  const subscribe = React.useCallback(
    (listener: () => void) => stateStore.subscribe(listener),
    [stateStore]
  )
  const getSnapshot = React.useCallback(() => {
    const state = stateStore.getSnapshot()
    return direction === "start" ? state.start : state.end
  }, [direction, stateStore])
  const active = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const handleClick = React.useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!active) return
      onClickRef.current?.(event)
      if (event.defaultPrevented) return
      event.currentTarget.blur()
      if (direction === "start") scrollToStart({ behavior })
      else scrollToEnd({ behavior })
    },
    [active, behavior, direction, scrollToEnd, scrollToStart]
  )

  return renderElement(
    "button",
    mergeProps(
      {
        "data-slot": "message-scroller-button",
        "data-direction": direction,
        "data-variant": variant,
        "data-size": size,
        "data-active": active ? "true" : "false",
        type,
        inert: !active,
        tabIndex: active ? tabIndex : -1,
        onClick: handleClick,
        className: cn(
          "absolute inset-s-1/2 -translate-x-1/2 border-border bg-background text-foreground transition-[translate,scale,opacity] duration-200 hover:bg-muted hover:text-foreground data-[active=false]:pointer-events-none data-[active=false]:scale-95 data-[active=false]:opacity-0 data-[active=false]:duration-400 data-[active=false]:ease-[cubic-bezier(0.7,0,0.84,0)] data-[active=true]:translate-y-0 data-[active=true]:scale-100 data-[active=true]:opacity-100 data-[active=true]:ease-[cubic-bezier(0.23,1,0.32,1)] data-[direction=end]:bottom-4 data-[direction=end]:data-[active=false]:translate-y-full data-[direction=start]:top-4 data-[direction=start]:data-[active=false]:-translate-y-full rtl:translate-x-1/2 data-[direction=start]:[&_svg]:rotate-180",
          className
        ),
        children: children ?? (
          <>
            <ArrowDownIcon aria-hidden="true" />
            <span className="sr-only">
              {direction === "end" ? "Scroll to end" : "Scroll to start"}
            </span>
          </>
        ),
      },
      props
    ),
    render ?? <Button variant={variant} size={size} />,
    { active, direction }
  )
}

export {
  MessageScrollerProvider,
  MessageScroller,
  MessageScrollerViewport,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerButton,
  useMessageScroller,
  useMessageScrollerScrollable,
  useMessageScrollerVisibility,
}
export type {
  MessageScrollerDefaultScrollPosition,
  MessageScrollerScrollAlign,
  MessageScrollerScrollOptions,
  MessageScrollerScrollable,
  MessageScrollerVisibilityState,
}
