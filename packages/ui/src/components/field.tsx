import { useMemo, type ComponentProps, type ReactNode } from "react"
import {
  Field as FieldPrimitive,
  FieldControl,
  FieldDescription as FieldDescriptionPrimitive,
  FieldError as FieldErrorPrimitive,
  FieldGroup as FieldGroupPrimitive,
  FieldLabel as FieldLabelPrimitive,
  FieldLegend as FieldLegendPrimitive,
  FieldSet as FieldSetPrimitive,
} from "@ui-sdk/react/field"
import { cva, type VariantProps } from "class-variance-authority"

import { omitUndefined, type RelaxOptional } from "#lib/ui-props"
import { cn } from "#lib/utils"
import { Separator } from "#components/separator"

function parseBooleanDataAttr(
  value: boolean | string | undefined
): boolean | undefined {
  if (value === undefined) return undefined
  if (value === true || value === "" || value === "true") return true
  if (value === false || value === "false") return false
  return undefined
}

function FieldSet({
  className,
  ...props
}: RelaxOptional<
  Omit<ComponentProps<typeof FieldSetPrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: ReactNode | undefined
}) {
  return (
    <FieldSetPrimitive
      className={cn(
        "flex flex-col gap-4 has-[>[data-slot=checkbox-group]]:gap-3 has-[>[data-slot=radio-group]]:gap-3",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function FieldLegend({
  className,
  variant = "legend",
  ...props
}: RelaxOptional<
  Omit<ComponentProps<typeof FieldLegendPrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: ReactNode | undefined
  variant?: "legend" | "label" | undefined
}) {
  return (
    <FieldLegendPrimitive
      data-variant={variant}
      className={cn(
        "mb-1.5 font-medium data-[variant=label]:text-sm data-[variant=legend]:text-base",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function FieldGroup({
  className,
  ...props
}: RelaxOptional<
  Omit<ComponentProps<typeof FieldGroupPrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: ReactNode | undefined
}) {
  return (
    <FieldGroupPrimitive
      className={cn(
        "group/field-group @container/field-group flex w-full flex-col gap-5 data-[slot=checkbox-group]:gap-3 *:data-[slot=field-group]:gap-4",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

const fieldVariants = cva(
  "group/field flex w-full gap-2 data-invalid:text-destructive",
  {
    variants: {
      orientation: {
        vertical: "flex-col *:w-full [&>.sr-only]:w-auto",
        horizontal:
          "flex-row items-center has-[>[data-slot=field-content]]:items-start *:data-[slot=field-label]:flex-auto has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
        responsive:
          "flex-col *:w-full @md/field-group:flex-row @md/field-group:items-center @md/field-group:*:w-auto @md/field-group:has-[>[data-slot=field-content]]:items-start @md/field-group:*:data-[slot=field-label]:flex-auto [&>.sr-only]:w-auto @md/field-group:has-[>[data-slot=field-content]]:[&>[role=checkbox],[role=radio]]:mt-px",
      },
    },
    defaultVariants: {
      orientation: "vertical",
    },
  }
)

type FieldProps = RelaxOptional<
  Omit<ComponentProps<typeof FieldPrimitive>, "className" | "children">
> &
  RelaxOptional<VariantProps<typeof fieldVariants>> & {
    className?: string | undefined
    children?: ReactNode | undefined
    "data-invalid"?: boolean | string | undefined
    "data-disabled"?: boolean | string | undefined
  }

function Field({
  className,
  orientation = "vertical",
  invalid,
  disabled,
  render,
  "data-invalid": dataInvalid,
  "data-disabled": dataDisabled,
  ...props
}: FieldProps) {
  const resolvedInvalid = invalid ?? parseBooleanDataAttr(dataInvalid)
  const resolvedDisabled = disabled ?? parseBooleanDataAttr(dataDisabled)
  return (
    <FieldPrimitive
      {...(resolvedInvalid !== undefined ? { invalid: resolvedInvalid } : {})}
      {...(resolvedDisabled !== undefined
        ? { disabled: resolvedDisabled }
        : {})}
      data-orientation={orientation}
      className={cn(fieldVariants({ orientation }), className)}
      render={
        render ??
        ((slotProps) => {
          const { "data-invalid": invalidAttr, ...restSlotProps } =
            slotProps as typeof slotProps & { "data-invalid"?: string }
          return (
            <div
              {...restSlotProps}
              {...(invalidAttr !== undefined ? { "data-invalid": "true" } : {})}
            />
          )
        })
      }
      {...omitUndefined(props)}
    />
  )
}

function FieldContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="field-content"
      className={cn(
        "group/field-content flex flex-1 flex-col gap-0.5 leading-snug",
        className
      )}
      {...props}
    />
  )
}

function FieldLabel({
  className,
  ...props
}: RelaxOptional<
  Omit<ComponentProps<typeof FieldLabelPrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: ReactNode | undefined
}) {
  return (
    <FieldLabelPrimitive
      className={cn(
        "group/field-label peer/field-label flex w-fit items-center gap-2 text-sm leading-snug font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50 group-data-disabled/field:pointer-events-none group-data-disabled/field:opacity-50 has-data-checked:border-primary/30 has-data-checked:bg-primary/5 has-[>[data-slot=field]]:rounded-lg has-[>[data-slot=field]]:border has-[>[data-slot=field]]:not-has-[:disabled,[data-disabled]]:hover:bg-muted/50 has-[>[data-slot=field]]:has-[:focus-visible]:border-ring has-[>[data-slot=field]]:has-[:focus-visible]:ring-3 has-[>[data-slot=field]]:has-[:focus-visible]:ring-ring/50 *:data-[slot=field]:p-2.5 dark:has-data-checked:border-primary/20 dark:has-data-checked:bg-primary/10",
        "has-[>[data-slot=field]]:w-full has-[>[data-slot=field]]:flex-col",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function FieldTitle({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="field-label"
      className={cn(
        "flex w-fit items-center gap-2 text-sm font-medium group-data-disabled/field:opacity-50",
        className
      )}
      {...props}
    />
  )
}

function FieldDescription({
  className,
  ...props
}: RelaxOptional<
  Omit<
    ComponentProps<typeof FieldDescriptionPrimitive>,
    "className" | "children"
  >
> & {
  className?: string | undefined
  children?: ReactNode | undefined
}) {
  return (
    <FieldDescriptionPrimitive
      className={cn(
        "text-left text-sm leading-normal font-normal text-muted-foreground group-has-data-horizontal/field:text-balance [[data-variant=legend]+&]:-mt-1.5",
        "last:mt-0 nth-last-2:-mt-1",
        "[&>a]:underline [&>a]:underline-offset-4 [&>a:hover]:text-primary",
        className
      )}
      {...omitUndefined(props)}
    />
  )
}

function FieldSeparator({
  children,
  className,
  ...props
}: ComponentProps<"div"> & {
  children?: ReactNode | undefined
}) {
  return (
    <div
      data-slot="field-separator"
      data-content={!!children}
      className={cn(
        "relative -my-2 h-5 text-sm group-data-[variant=outline]/field-group:-mb-2",
        className
      )}
      {...props}
    >
      <Separator className="absolute inset-0 top-1/2" />
      {children && (
        <span
          className="relative mx-auto block w-fit bg-background px-2 text-muted-foreground"
          data-slot="field-separator-content"
        >
          {children}
        </span>
      )}
    </div>
  )
}

function FieldError({
  className,
  children,
  errors,
  match,
  role = "alert",
  ...props
}: RelaxOptional<
  Omit<ComponentProps<typeof FieldErrorPrimitive>, "className" | "children">
> & {
  className?: string | undefined
  children?: ReactNode | undefined
  errors?: Array<{ message?: string } | undefined> | undefined
}) {
  const content = useMemo(() => {
    if (children) {
      return children
    }

    if (!errors?.length) {
      return null
    }

    const uniqueErrors = [
      ...new Map(errors.map((error) => [error?.message, error])).values(),
    ]

    if (uniqueErrors.length === 1) {
      return uniqueErrors[0]?.message
    }

    return (
      <ul className="ml-4 flex list-disc flex-col gap-1">
        {uniqueErrors.map(
          (error, index) =>
            error?.message && <li key={index}>{error.message}</li>
        )}
      </ul>
    )
  }, [children, errors])

  if (!content && match === undefined) {
    return null
  }

  return (
    <FieldErrorPrimitive
      role={role}
      match={match ?? true}
      className={cn("text-sm font-normal text-destructive", className)}
      {...omitUndefined(props)}
    >
      {content ?? undefined}
    </FieldErrorPrimitive>
  )
}

export {
  Field,
  FieldControl,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
}
