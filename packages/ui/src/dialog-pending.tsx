"use client"

import * as React from "react"

const DialogPendingContext = React.createContext(false)

function useDialogPending() {
  return React.useContext(DialogPendingContext)
}

export { DialogPendingContext, useDialogPending }
