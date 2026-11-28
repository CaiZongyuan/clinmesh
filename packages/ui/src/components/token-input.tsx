"use client"

import * as React from "react"
import {
  createTokenInputController,
  TokenInput as TokenInputPrimitive,
  TokenInputEditor as TokenInputEditorPrimitive,
  TokenInputToken as TokenInputTokenPrimitive,
  TokenInputTokenRemove as TokenInputTokenRemovePrimitive,
  type Token,
  type TokenInputValue,
} from "@ui-sdk/react/token-input"
import {
  TriggerMenu as TriggerMenuPrimitive,
  TriggerMenuContent as TriggerMenuContentPrimitive,
  TriggerMenuEmpty as TriggerMenuEmptyPrimitive,
  TriggerMenuItem as TriggerMenuItemPrimitive,
  TriggerMenuList as TriggerMenuListPrimitive,
} from "@ui-sdk/react/trigger-menu"
import { XIcon } from "lucide-react"

import { cn } from "#lib/utils"

export interface MentionOption {
  value: string
  label: string
  category?: string
}

interface MentionTokenInputProps {
  ariaLabel?: string
  placeholder?: string
  trigger?: string
  options: readonly MentionOption[]
  defaultValue?: TokenInputValue
  onValueChange?: (value: TokenInputValue) => void
  className?: string
}

function MentionTokenInput({
  ariaLabel = "结构化提及输入框",
  placeholder = "输入 @ 引用患者、检验或处方上下文…",
  trigger = "@",
  options,
  defaultValue,
  onValueChange,
  className,
}: MentionTokenInputProps) {
  return (
    <TokenInputPrimitive
      {...(defaultValue !== undefined ? { defaultValue } : {})}
      {...(onValueChange !== undefined ? { onValueChange } : {})}
      renderToken={(token: Token) => (
        <TokenInputTokenPrimitive className="mx-0.5 inline-flex items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-foreground">
          <span>{token.label}</span>
          <TokenInputTokenRemovePrimitive
            aria-label={`移除 ${token.label}`}
            className="inline-flex size-3.5 cursor-pointer items-center justify-center rounded-xs hover:bg-background/60"
          >
            <XIcon aria-hidden="true" className="size-2.5" />
          </TokenInputTokenRemovePrimitive>
        </TokenInputTokenPrimitive>
      )}
    >
      <TriggerMenuPrimitive
        triggers={[
          {
            char: trigger,
            items: options.map(opt => ({
              value: opt.value,
              label: opt.label,
            })),
          },
        ]}
      >
        <TokenInputEditorPrimitive
          aria-label={ariaLabel}
          className={cn(
            "min-h-20 w-full rounded-lg border border-input bg-card px-3 py-2 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[empty]:before:pointer-events-none data-[empty]:before:text-muted-foreground data-[empty]:before:content-[attr(data-placeholder)]",
            className,
          )}
          data-placeholder={placeholder}
          placeholder={placeholder}
        />
        <TriggerMenuContentPrimitive className="z-50 min-w-52 overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-border/60">
          <TriggerMenuListPrimitive className="max-h-48 overflow-y-auto">
            {options.map(opt => (
              <TriggerMenuItemPrimitive
                className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
                key={opt.value}
                value={opt.value}
              >
                <span>{opt.label}</span>
                {opt.category ? (
                  <span className="text-[11px] text-muted-foreground">{opt.category}</span>
                ) : null}
              </TriggerMenuItemPrimitive>
            ))}
          </TriggerMenuListPrimitive>
          <TriggerMenuEmptyPrimitive className="py-3 text-center text-xs text-muted-foreground empty:hidden">
            无匹配上下文
          </TriggerMenuEmptyPrimitive>
        </TriggerMenuContentPrimitive>
      </TriggerMenuPrimitive>
    </TokenInputPrimitive>
  )
}

export {
  createTokenInputController,
  MentionTokenInput,
  type MentionTokenInputProps,
  type Token,
  type TokenInputValue,
}
