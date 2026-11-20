import type { MedicationPackageInsert } from '@clinmesh/contracts/medication-safety'
import { Button } from '@clinmesh/ui/components/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@clinmesh/ui/components/sheet'
import { cn } from '@clinmesh/ui/lib/utils'
import { BookOpenIcon } from 'lucide-react'
import type { WorkspaceLocale } from './workspace-i18n.ts'

export interface MedicationPackageInsertTarget {
  packageInsert?: MedicationPackageInsert | undefined
  subtitle?: string | undefined
  title: string
}

export function MedicationInsertTriggerButton({
  className,
  locale,
  onOpen,
}: {
  className?: string | undefined
  locale: WorkspaceLocale
  onOpen: () => void
}): React.JSX.Element {
  return (
    <Button
      className={cn('shrink-0', className)}
      data-medication-insert-trigger=""
      onClick={event => {
        event.stopPropagation()
        onOpen()
      }}
      onDoubleClick={event => event.stopPropagation()}
      size="xs"
      type="button"
      variant="ghost"
    >
      <BookOpenIcon data-icon="inline-start" />
      {locale === 'zh-CN' ? '说明书' : 'Insert'}
    </Button>
  )
}

export function MedicationPackageInsertSheet({
  locale,
  onClose,
  target,
}: {
  locale: WorkspaceLocale
  onClose: () => void
  target: MedicationPackageInsertTarget | null
}): React.JSX.Element {
  const zh = locale === 'zh-CN'
  const insert = target?.packageInsert
  const subtitle = insert?.specificationAndForm ?? target?.subtitle
  const sections: ReadonlyArray<readonly [label: string, value: string]> = insert === undefined
    ? []
    : [
        [zh ? '通用名' : 'Generic name', insert.genericName],
        [zh ? '规格剂型' : 'Strength & dosage form', insert.specificationAndForm],
        [zh ? '适应证摘要' : 'Indications', insert.indicationsSummary],
        [zh ? '常规用法用量' : 'Dosage & administration', insert.dosageAndAdministration],
        [zh ? '禁忌证' : 'Contraindications', insert.contraindications],
        [zh ? '注意事项' : 'Precautions', insert.precautions],
        [zh ? '常见不良反应' : 'Adverse reactions', insert.adverseReactions],
      ]

  return (
    <Sheet onOpenChange={open => { if (!open) onClose() }} open={target !== null}>
      <SheetContent
        className="w-full overflow-y-auto sm:max-w-md"
        data-medication-package-insert=""
        forceOverlay
        side="right"
      >
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{zh ? '药品说明书摘要' : 'Medication package insert summary'}</SheetTitle>
          <SheetDescription className="break-words">
            {[insert?.genericName ?? target?.title, subtitle].filter(Boolean).join(' · ')}
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-6 text-sm">
          {insert === undefined ? (
            <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
              {zh ? '暂无院内说明书摘要' : 'No hospital package insert summary available'}
            </p>
          ) : (
            <>
              <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs font-medium text-foreground">
                {insert.disclaimer}
              </p>
              <dl className="flex flex-col gap-3">
                {sections.map(([label, value]) => (
                  <div className="flex flex-col gap-1 border-b pb-2.5 last:border-b-0 last:pb-0" key={label}>
                    <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
                    <dd className="whitespace-pre-wrap break-words leading-relaxed text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
