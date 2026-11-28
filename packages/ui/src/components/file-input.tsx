"use client"

import * as React from "react"
import {
  FileInput as FileInputPrimitive,
  FileInputDropzone as FileInputDropzonePrimitive,
  FileInputItem as FileInputItemPrimitive,
  FileInputItemRemove as FileInputItemRemovePrimitive,
  FileInputList as FileInputListPrimitive,
  FileInputTrigger as FileInputTriggerPrimitive,
  formatFileSize,
} from "@ui-sdk/react/file-input"
import { FileTextIcon, UploadCloudIcon, XIcon } from "lucide-react"

import { Button } from "#components/button"
import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"

interface FileDropzoneProps
  extends RelaxOptional<
    Omit<React.ComponentProps<typeof FileInputPrimitive>, "className" | "children">
  > {
  className?: string | undefined
  title?: string | undefined
  hint?: string | undefined
  buttonLabel?: string | undefined
}

function FileDropzone({
  className,
  title = "拖拽文件到此处，或点击选择",
  hint = "本地浏览器处理，不上传外部服务器",
  buttonLabel = "选择文件",
  ...props
}: FileDropzoneProps) {
  return (
    <FileInputPrimitive
      className={cn("flex flex-col gap-2.5", className)}
      {...omitUndefined(props)}
    >
      <FileInputDropzonePrimitive className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/25 px-4 py-5 text-center transition-colors data-[dragging]:border-info data-[dragging]:bg-accent/40">
        <UploadCloudIcon aria-hidden="true" className="size-6 text-muted-foreground" />
        <div className="text-xs font-medium text-foreground">{title}</div>
        <div className="text-[11px] text-muted-foreground">{hint}</div>
        <FileInputTriggerPrimitive
          render={<Button size="xs" type="button" variant="outline" />}
        >
          {buttonLabel}
        </FileInputTriggerPrimitive>
      </FileInputDropzonePrimitive>
      <FileInputListPrimitive className="flex flex-col gap-1.5 empty:hidden">
        <FileInputItemPrimitive className="flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs">
          {({ file }) => (
            <>
              <FileTextIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate text-foreground">{file.name}</span>
              <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
                {formatFileSize(file.size)}
              </span>
              <FileInputItemRemovePrimitive
                aria-label={`移除文件 ${file.name}`}
                className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <XIcon aria-hidden="true" className="size-3" />
              </FileInputItemRemovePrimitive>
            </>
          )}
        </FileInputItemPrimitive>
      </FileInputListPrimitive>
    </FileInputPrimitive>
  )
}

export { FileDropzone, formatFileSize, type FileDropzoneProps }
