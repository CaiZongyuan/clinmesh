"use client"

import * as React from "react"
import {
  PasswordInput as PasswordInputPrimitive,
  PasswordInputControl as PasswordInputControlPrimitive,
  PasswordInputToggle as PasswordInputTogglePrimitive,
} from "@ui-sdk/react/password-input"
import { EyeIcon, EyeOffIcon } from "lucide-react"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

interface PasswordInputFieldProps
  extends RelaxOptional<
    Omit<React.ComponentProps<typeof PasswordInputPrimitive>, "className" | "children">
  > {
  className?: string | undefined
  placeholder?: string | undefined
  inputAriaLabel?: string | undefined
  toggleLabel?: string | undefined
  secretAttribute?: boolean | undefined
}

function PasswordInputField({
  className,
  placeholder,
  inputAriaLabel,
  toggleLabel = "显示或隐藏密码",
  secretAttribute = false,
  ...props
}: PasswordInputFieldProps) {
  return (
    <PasswordInputPrimitive
      className={cn(
        "relative inline-flex h-8 w-full items-center overflow-hidden rounded-lg border border-input bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50",
        className,
      )}
      {...omitUndefined(props)}
    >
      {({ visible }) => (
        <>
          <PasswordInputControlPrimitive
            aria-label={inputAriaLabel}
            className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            data-agent-secret={secretAttribute ? "" : undefined}
            placeholder={placeholder}
          />
          <PasswordInputTogglePrimitive
            aria-label={toggleLabel}
            className="inline-flex h-full w-8 shrink-0 cursor-pointer items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
          >
            {visible ? (
              <EyeOffIcon aria-hidden="true" className="size-3.5" />
            ) : (
              <EyeIcon aria-hidden="true" className="size-3.5" />
            )}
          </PasswordInputTogglePrimitive>
        </>
      )}
    </PasswordInputPrimitive>
  )
}

export { PasswordInputField, type PasswordInputFieldProps }
