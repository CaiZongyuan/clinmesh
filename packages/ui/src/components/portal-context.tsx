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

export { PortalContainerProvider, usePortalContainer }
