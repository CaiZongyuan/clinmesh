import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@clinmesh/ui/components/alert-dialog'
import { Badge } from '@clinmesh/ui/components/badge'
import { Button } from '@clinmesh/ui/components/button'
import { Field, FieldError, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { toast } from '@clinmesh/ui/components/toast'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import {
  CheckIcon,
  CircleAlertIcon,
  FilePlus2Icon,
  MoonIcon,
  SaveIcon,
  SendIcon,
  SunIcon,
  Trash2Icon,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  getComponentCatalogMessages,
  type ComponentCatalogMessages,
} from './component-catalog-i18n.ts'
import {
  applyResolvedWebTheme,
  readWebPreferences,
  type ResolvedWebTheme,
  writeWebPreferences,
} from './preferences.ts'

function currentDocumentTheme(): ResolvedWebTheme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

function persistCatalogTheme(theme: ResolvedWebTheme): void {
  applyResolvedWebTheme(theme)
  writeWebPreferences({ ...readWebPreferences(), theme })
}

function ThemeControl({ messages }: { messages: ComponentCatalogMessages }): React.JSX.Element {
  const [theme, setTheme] = useState(currentDocumentTheme)

  return (
    <ToggleGroup
      aria-label={messages.themePreview}
      onValueChange={values => {
        const nextTheme = (values as ResolvedWebTheme[])[0]
        if (nextTheme === undefined) return
        setTheme(nextTheme)
        persistCatalogTheme(nextTheme)
      }}
      size="sm"
      spacing={0}
      value={[theme]}
      variant="outline"
    >
      <ToggleGroupItem aria-label={messages.lightTheme} title={messages.lightTheme} value="light">
        <SunIcon aria-hidden="true" />
      </ToggleGroupItem>
      <ToggleGroupItem aria-label={messages.darkTheme} title={messages.darkTheme} value="dark">
        <MoonIcon aria-hidden="true" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
}

function ButtonShowcase({ messages }: { messages: ComponentCatalogMessages }): React.JSX.Element {
  return (
    <section aria-labelledby="catalog-buttons-heading" className="flex flex-col gap-4 border-b pb-8">
      <h2 className="text-sm font-semibold" id="catalog-buttons-heading">{messages.buttonsHeading}</h2>
      <div className="flex flex-wrap items-end gap-3">
        <Button size="xs" type="button">
          <FilePlus2Icon data-icon="inline-start" />
          {messages.addendum}
        </Button>
        <Button size="sm" type="button">{messages.temporarySave}</Button>
        <Button type="button">{messages.saveRecord}</Button>
        <Button size="lg" type="button">
          <CheckIcon data-icon="inline-start" />
          {messages.signAndSubmit}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="secondary" type="button">{messages.secondaryAction}</Button>
        <Button variant="outline" type="button">{messages.adjust}</Button>
        <Button variant="ghost" type="button">{messages.cancel}</Button>
        <Button variant="destructive" type="button">
          <Trash2Icon data-icon="inline-start" />
          {messages.deleteDraft}
        </Button>
        <Button disabled type="button">{messages.noPermission}</Button>
        <Button disabled type="button">
          <Spinner aria-hidden="true" data-icon="inline-start" />
          {messages.submitting}
        </Button>
      </div>
    </section>
  )
}

function FormShowcase({ messages }: { messages: ComponentCatalogMessages }): React.JSX.Element {
  return (
    <section aria-labelledby="catalog-form-heading" className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold" id="catalog-form-heading">{messages.clinicalFormHeading}</h2>
      <form id="component-catalog-form" onSubmit={event => event.preventDefault()}>
        <FieldGroup className="md:grid md:grid-cols-2">
          <Field data-disabled>
            <FieldLabel htmlFor="catalog-patient-name">{messages.patientNameLabel}</FieldLabel>
            <Input disabled id="catalog-patient-name" value={messages.syntheticPatientName} readOnly />
          </Field>
          <Field>
            <FieldLabel htmlFor="catalog-chief-complaint">{messages.chiefComplaintLabel}</FieldLabel>
            <Input defaultValue={messages.chiefComplaintValue} id="catalog-chief-complaint" />
          </Field>
          <Field data-invalid>
            <FieldLabel htmlFor="catalog-diagnosis">{messages.preliminaryDiagnosisLabel}</FieldLabel>
            <Input
              aria-describedby="catalog-diagnosis-error"
              aria-invalid="true"
              id="catalog-diagnosis"
              placeholder={messages.diagnosisPlaceholder}
            />
            <FieldError aria-label={messages.diagnosisRequired} id="catalog-diagnosis-error">
              {messages.diagnosisRequired}
            </FieldError>
          </Field>
          <Field>
            <FieldLabel id="catalog-priority-label">{messages.priorityLabel}</FieldLabel>
            <ToggleGroup aria-labelledby="catalog-priority-label" defaultValue={['routine']} variant="outline">
              <ToggleGroupItem value="routine">{messages.routine}</ToggleGroupItem>
              <ToggleGroupItem value="urgent">{messages.urgent}</ToggleGroupItem>
              <ToggleGroupItem disabled value="critical">{messages.critical}</ToggleGroupItem>
            </ToggleGroup>
          </Field>
          <Field className="md:col-span-2">
            <FieldLabel htmlFor="catalog-history">{messages.presentIllnessLabel}</FieldLabel>
            <Textarea
              defaultValue={messages.historyValue}
              id="catalog-history"
            />
          </Field>
        </FieldGroup>
      </form>
    </section>
  )
}

function ClinicalShowcase({ messages }: { messages: ComponentCatalogMessages }): React.JSX.Element {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
      <section aria-labelledby="catalog-status-heading" className="flex flex-col gap-4 border-b pb-8">
        <h2 className="text-sm font-semibold" id="catalog-status-heading">{messages.semanticStatusHeading}</h2>
        <div className="flex flex-wrap gap-2">
          <Badge>{messages.inProgress}</Badge>
          <Badge variant="secondary">{messages.awaitingConsultation}</Badge>
          <Badge variant="success">{messages.completed}</Badge>
          <Badge variant="warning">{messages.awaitingReview}</Badge>
          <Badge variant="info">{messages.synced}</Badge>
          <Badge variant="destructive">{messages.penicillinAllergy}</Badge>
          <Badge variant="outline">{messages.discontinued}</Badge>
        </div>
      </section>
      <section aria-labelledby="catalog-table-heading" className="flex flex-col gap-4 border-b pb-8">
        <h2 className="text-sm font-semibold" id="catalog-table-heading">{messages.tableHeading}</h2>
        <Table aria-label={messages.tableLabel}>
          <TableHeader>
            <TableRow>
              <TableHead>{messages.sampleTime}</TableHead>
              <TableHead>{messages.testItem}</TableHead>
              <TableHead>{messages.result}</TableHead>
              <TableHead>{messages.referenceRange}</TableHead>
              <TableHead>{messages.status}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className="tabular-nums">08:42</TableCell>
              <TableCell>{messages.cbc}</TableCell>
              <TableCell className="font-medium tabular-nums">12.6 × 10^9/L</TableCell>
              <TableCell className="tabular-nums">3.5–9.5</TableCell>
              <TableCell><Badge variant="warning">{messages.high}</Badge></TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="tabular-nums">08:42</TableCell>
              <TableCell>{messages.crp}</TableCell>
              <TableCell className="font-medium tabular-nums">6.2 mg/L</TableCell>
              <TableCell className="tabular-nums">0–8</TableCell>
              <TableCell><Badge variant="success">{messages.normal}</Badge></TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </section>
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="catalog-loading-heading" className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold" id="catalog-loading-heading">{messages.loadingHeading}</h2>
          <div aria-label={messages.loadingCase} className="flex flex-col gap-3" role="status">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-4/5" />
          </div>
        </section>
        <section aria-labelledby="catalog-error-heading" className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold" id="catalog-error-heading">{messages.errorHeading}</h2>
          <Alert aria-label={messages.prescriptionReviewFailed} variant="destructive">
            <CircleAlertIcon aria-hidden="true" />
            <AlertTitle>{messages.prescriptionReviewFailed}</AlertTitle>
            <AlertDescription>
              {messages.errorDescription}
            </AlertDescription>
          </Alert>
        </section>
      </div>
    </div>
  )
}

function FeedbackShowcase({ messages }: { messages: ComponentCatalogMessages }): React.JSX.Element {
  return (
    <div className="mx-auto grid w-full max-w-7xl gap-8 lg:grid-cols-2">
      <section aria-labelledby="catalog-dialog-heading" className="flex flex-col items-start gap-4 border-b pb-8 lg:border-r lg:border-b-0 lg:pr-8">
        <h2 className="text-sm font-semibold" id="catalog-dialog-heading">{messages.dialogHeading}</h2>
        <AlertDialog>
          <AlertDialogTrigger render={<Button type="button" variant="destructive" />}>
            <Trash2Icon data-icon="inline-start" />
            {messages.deleteOrder}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia><Trash2Icon aria-hidden="true" /></AlertDialogMedia>
              <AlertDialogTitle>{messages.confirmDeleteOrder}</AlertDialogTitle>
              <AlertDialogDescription>
                {messages.dialogDescription}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{messages.cancelDeletion}</AlertDialogCancel>
              <AlertDialogAction variant="destructive">
                <Trash2Icon data-icon="inline-start" />
                {messages.confirmDeletion}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </section>
      <section aria-labelledby="catalog-toast-heading" className="flex flex-col items-start gap-4">
        <h2 className="text-sm font-semibold" id="catalog-toast-heading">{messages.operationFeedbackHeading}</h2>
        <div className="flex flex-wrap gap-3">
          <Button
            onClick={() => toast.add({
              description: messages.successDescription,
              title: messages.recordSaved,
              type: 'success',
            })}
            type="button"
          >
            {messages.sendSuccessFeedback}
          </Button>
          <Button
            onClick={() => toast.add({
              description: messages.warningDescription,
              title: messages.submissionConflict,
              type: 'warning',
            })}
            type="button"
            variant="outline"
          >
            {messages.sendWarningFeedback}
          </Button>
          <Button
            onClick={() => toast.add({
              description: messages.loadingDescription,
              title: messages.submitting,
              type: 'loading',
            })}
            type="button"
            variant="secondary"
          >
            {messages.sendLoadingFeedback}
          </Button>
        </div>
      </section>
    </div>
  )
}

export function ComponentCatalog(): React.JSX.Element {
  const locale = readWebPreferences().locale
  const messages = getComponentCatalogMessages(locale)

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  return (
    <main className="flex min-h-svh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-10 flex h-[3.375rem] shrink-0 items-center border-b bg-background px-4 sm:px-6">
        <h1 className="text-base font-semibold">{messages.catalogTitle}</h1>
        <div className="ml-auto"><ThemeControl messages={messages} /></div>
      </header>
      <Tabs className="min-h-0 flex-1 gap-0" defaultValue="controls">
        <div className="overflow-x-auto border-b px-4 sm:px-6">
          <TabsList aria-label={messages.categoryTabs} className="h-[2.875rem]" variant="line">
            <TabsTrigger value="controls">{messages.controlsTab}</TabsTrigger>
            <TabsTrigger value="clinical">{messages.clinicalTab}</TabsTrigger>
            <TabsTrigger value="feedback">{messages.feedbackTab}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent className="p-4 sm:p-6" value="controls">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
            <ButtonShowcase messages={messages} />
            <FormShowcase messages={messages} />
          </div>
        </TabsContent>
        <TabsContent className="p-4 sm:p-6" value="clinical">
          <ClinicalShowcase messages={messages} />
        </TabsContent>
        <TabsContent className="p-4 sm:p-6" value="feedback">
          <FeedbackShowcase messages={messages} />
        </TabsContent>
      </Tabs>
      <section aria-label={messages.submitRegion} className="sticky bottom-0 flex min-h-14 items-center justify-end gap-2 border-t bg-background px-4 py-3 sm:px-6">
        <Button form="component-catalog-form" type="button" variant="outline">
          <SaveIcon data-icon="inline-start" />
          {messages.saveDraft}
        </Button>
        <Button form="component-catalog-form" type="submit">
          <SendIcon data-icon="inline-start" />
          {messages.submit}
        </Button>
      </section>
    </main>
  )
}
