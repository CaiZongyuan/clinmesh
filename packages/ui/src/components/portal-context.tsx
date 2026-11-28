"use client"

import * as React from "react"

export type PortalContainer =
  | HTMLElement
  | ShadowRoot
  | React.RefObject<HTMLElement | ShadowRoot | null>
  | null

const PortalContainerContext = React.createContext<PortalContainer>(null)

function PortalContainerProvider({
  children,
  container,
}: {
  children: React.ReactNode
  container: PortalContainer
}) {
  return (
    <PortalContainerContext.Provider value={container}>
      {children}
    </PortalContainerContext.Provider>
  )
}

function usePortalContainer(): PortalContainer {
  return React.useContext(PortalContainerContext)
}

function resolvePortalContainer(
  container: PortalContainer | Element | DocumentFragment | null | undefined
): Element | DocumentFragment | undefined {
  if (container === null || container === undefined) return undefined
  if ("current" in container) return container.current ?? undefined
  return container
}

export { PortalContainerProvider, resolvePortalContainer, usePortalContainer }
