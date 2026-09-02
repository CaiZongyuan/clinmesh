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
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from '@clinmesh/ui/components/avatar'
import { Badge } from '@clinmesh/ui/components/badge'
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@clinmesh/ui/components/breadcrumb'
import { Bubble, BubbleContent } from '@clinmesh/ui/components/bubble'
import { Button } from '@clinmesh/ui/components/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@clinmesh/ui/components/card'
import { Checkbox } from '@clinmesh/ui/components/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@clinmesh/ui/components/dropdown-menu'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@clinmesh/ui/components/empty'
import { Field, FieldError, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@clinmesh/ui/components/input-group'
import { Input } from '@clinmesh/ui/components/input'
import { Marker, MarkerContent, MarkerIcon } from '@clinmesh/ui/components/marker'
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from '@clinmesh/ui/components/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@clinmesh/ui/components/message-scroller'
import { Progress } from '@clinmesh/ui/components/progress'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@clinmesh/ui/components/select'
import { Separator } from '@clinmesh/ui/components/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@clinmesh/ui/components/sheet'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Spinner } from '@clinmesh/ui/components/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@clinmesh/ui/components/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@clinmesh/ui/components/tabs'
import { Textarea } from '@clinmesh/ui/components/textarea'
import { toast } from '@clinmesh/ui/components/toast'
import { Toggle } from '@clinmesh/ui/components/toggle'
import { ToggleGroup, ToggleGroupItem } from '@clinmesh/ui/components/toggle-group'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@clinmesh/ui/components/tooltip'
import { cn } from '@clinmesh/ui/lib/utils'
import {
  CheckIcon,
  BoldIcon,
  BotIcon,
  ChevronDownIcon,
  CircleAlertIcon,
  FilePlus2Icon,
  FolderSearchIcon,
  InfoIcon,
  MoonIcon,
  PanelRightOpenIcon,
  SaveIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
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
import type { WorkspaceLocale } from './workspace-i18n.ts'
import { useWebRuntime } from './web-runtime.tsx'

function currentTheme(root: HTMLElement | null): ResolvedWebTheme {
  return (root ?? document.documentElement).classList.contains('dark') ? 'dark' : 'light'
}

function persistCatalogTheme(theme: ResolvedWebTheme, root: HTMLElement | null): void {
  applyResolvedWebTheme(theme, root ?? document.documentElement)
  writeWebPreferences({ ...readWebPreferences(), theme })
}

function ThemeControl({ messages }: { messages: ComponentCatalogMessages }): React.JSX.Element {
  const runtime = useWebRuntime()
  const appearanceRoot = runtime.mode === 'surface'
    ? runtime.appearanceRoot.current
    : document.documentElement
  const [theme, setTheme] = useState(() => currentTheme(appearanceRoot))

  return (
    <ToggleGroup
      aria-label={messages.themePreview}
      onValueChange={values => {
        const nextTheme = (values as ResolvedWebTheme[])[0]
        if (nextTheme === undefined) return
        setTheme(nextTheme)
        persistCatalogTheme(nextTheme, appearanceRoot)
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

function FoundationShowcase({ messages }: { messages: ComponentCatalogMessages }): React.JSX.Element {
  return (
    <div className="flex w-full flex-col gap-8">
      <section aria-labelledby="catalog-navigation-heading" className="flex flex-col gap-4 border-b pb-8">
        <h3 className="text-sm font-semibold" id="catalog-navigation-heading">
          {messages.navigationHeading}
        </h3>
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>ClinMesh</BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>{messages.developer}</BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem><BreadcrumbPage>{messages.catalogTitle}</BreadcrumbPage></BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex flex-wrap items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="outline" />}>
              {messages.openActions}
              <ChevronDownIcon data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                <DropdownMenuItem>{messages.saveRecord}</DropdownMenuItem>
                <DropdownMenuItem>{messages.adjust}</DropdownMenuItem>
                <DropdownMenuItem>{messages.cancel}</DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Sheet>
            <SheetTrigger render={<Button type="button" variant="outline" />}>
              <PanelRightOpenIcon data-icon="inline-start" />
              {messages.openDetails}
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>{messages.patientSummaryHeading}</SheetTitle>
                <SheetDescription>{messages.sheetDescription}</SheetDescription>
              </SheetHeader>
              <div className="px-4">
                <Badge variant="info">{messages.inProgress}</Badge>
              </div>
            </SheetContent>
          </Sheet>
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger render={(
                <Button aria-label={messages.themePreview} size="icon" type="button" variant="ghost" />
              )}>
                <SettingsIcon aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>{messages.themePreview}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <Toggle aria-label={messages.bold} title={messages.bold} variant="outline">
            <BoldIcon aria-hidden="true" />
          </Toggle>
        </div>
        <Tabs className="w-full" defaultValue="summary">
          <TabsList variant="line">
            <TabsTrigger value="summary">{messages.patientSummaryHeading}</TabsTrigger>
            <TabsTrigger value="progress">{messages.workflowProgress}</TabsTrigger>
          </TabsList>
          <TabsContent className="pt-3" value="summary">
            <Badge variant="warning">{messages.awaitingReview}</Badge>
          </TabsContent>
          <TabsContent className="pt-3" value="progress">
            <Progress aria-label={messages.workflowProgress} value={68} />
          </TabsContent>
        </Tabs>
      </section>

      <section aria-labelledby="catalog-card-heading" className="flex flex-col gap-8">
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold" id="catalog-card-heading">
            {messages.patientSummaryHeading}
          </h3>
          <Card size="sm">
            <CardHeader>
              <CardTitle>{messages.syntheticPatientName}</CardTitle>
              <CardDescription>CM-2026-001</CardDescription>
              <CardAction><Badge variant="warning">{messages.awaitingReview}</Badge></CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Progress aria-label={messages.workflowProgress} value={68} />
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>{messages.workflowProgress}</span>
                <span className="tabular-nums">68%</span>
              </div>
            </CardContent>
            <CardFooter className="justify-between gap-3">
              <span className="text-xs text-muted-foreground">3 / 5</span>
              <Button size="sm" type="button" variant="ghost">{messages.openDetails}</Button>
            </CardFooter>
          </Card>
        </div>
        <div className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold">Avatar</h3>
          <AvatarGroup>
            <Avatar><AvatarFallback>周</AvatarFallback><AvatarBadge /></Avatar>
            <Avatar><AvatarFallback>李</AvatarFallback></Avatar>
            <Avatar><AvatarFallback><BotIcon aria-hidden="true" /></AvatarFallback></Avatar>
            <AvatarGroupCount>+2</AvatarGroupCount>
          </AvatarGroup>
          <Separator />
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <InfoIcon aria-hidden="true" />
            <span>{messages.sheetDescription}</span>
          </div>
        </div>
      </section>
    </div>
  )
}

function ButtonShowcase({ messages }: { messages: ComponentCatalogMessages }): React.JSX.Element {
  return (
    <section aria-labelledby="catalog-buttons-heading" className="flex flex-col gap-4 border-b pb-8">
      <h3 className="text-sm font-semibold" id="catalog-buttons-heading">{messages.buttonsHeading}</h3>
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
  const priorityItems = [
    { label: messages.routine, value: 'routine' },
    { label: messages.urgent, value: 'urgent' },
  ]

  return (
    <section aria-labelledby="catalog-form-heading" className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold" id="catalog-form-heading">{messages.clinicalFormHeading}</h3>
      <form id="component-catalog-form" onSubmit={event => event.preventDefault()}>
        <FieldGroup>
          <Field data-disabled>
            <FieldLabel htmlFor="catalog-patient-name">{messages.patientNameLabel}</FieldLabel>
            <Input disabled id="catalog-patient-name" value={messages.syntheticPatientName} readOnly />
          </Field>
          <Field>
            <FieldLabel htmlFor="catalog-chief-complaint">{messages.chiefComplaintLabel}</FieldLabel>
            <Input defaultValue={messages.chiefComplaintValue} id="catalog-chief-complaint" />
          </Field>
          <Field>
            <FieldLabel htmlFor="catalog-search">{messages.searchInputLabel}</FieldLabel>
            <InputGroup>
              <InputGroupAddon><SearchIcon aria-hidden="true" /></InputGroupAddon>
              <InputGroupInput id="catalog-search" placeholder={messages.diagnosisPlaceholder} />
            </InputGroup>
          </Field>
          <Field>
            <FieldLabel htmlFor="catalog-select">{messages.selectHeading}</FieldLabel>
            <Select defaultValue="routine" items={priorityItems}>
              <SelectTrigger id="catalog-select"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>{messages.priorityLabel}</SelectLabel>
                  <SelectItem value="routine">{messages.routine}</SelectItem>
                  <SelectItem value="urgent">{messages.urgent}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
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
          <Field orientation="horizontal">
            <Checkbox defaultChecked id="catalog-consent" />
            <FieldLabel htmlFor="catalog-consent">{messages.consentLabel}</FieldLabel>
          </Field>
          <Field>
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
    <div className="flex w-full flex-col gap-8">
      <section aria-labelledby="catalog-status-heading" className="flex flex-col gap-4 border-b pb-8">
        <h3 className="text-sm font-semibold" id="catalog-status-heading">{messages.semanticStatusHeading}</h3>
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
        <h3 className="text-sm font-semibold" id="catalog-table-heading">{messages.tableHeading}</h3>
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
      <div className="flex flex-col gap-8">
        <section aria-labelledby="catalog-loading-heading" className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold" id="catalog-loading-heading">{messages.loadingHeading}</h3>
          <div aria-label={messages.loadingCase} className="flex flex-col gap-3" role="status">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-4/5" />
          </div>
        </section>
        <section aria-labelledby="catalog-error-heading" className="flex flex-col gap-4">
          <h3 className="text-sm font-semibold" id="catalog-error-heading">{messages.errorHeading}</h3>
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

function ConversationShowcase({ messages }: { messages: ComponentCatalogMessages }): React.JSX.Element {
  return (
    <div className="flex w-full flex-col gap-4">
      <h3 className="text-sm font-semibold">{messages.conversationHeading}</h3>
      <MessageScrollerProvider autoScroll>
        <MessageScroller className="h-80 rounded-lg border bg-muted/20">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-5 p-4">
              <MessageScrollerItem messageId="catalog-session">
                <Marker variant="separator">
                  <MarkerIcon><InfoIcon /></MarkerIcon>
                  <MarkerContent>{messages.sessionBound}</MarkerContent>
                </Marker>
              </MessageScrollerItem>
              <MessageScrollerItem messageId="catalog-clinician" scrollAnchor>
                <Message align="end">
                  <MessageContent>
                    <MessageHeader>{messages.clinicianName}</MessageHeader>
                    <Bubble align="end" variant="outline">
                      <BubbleContent>{messages.chiefComplaintValue}</BubbleContent>
                    </Bubble>
                    <MessageFooter>09:24</MessageFooter>
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
              <MessageScrollerItem messageId="catalog-patient">
                <Message>
                  <MessageContent>
                    <MessageHeader>{messages.syntheticPatientName}</MessageHeader>
                    <Bubble variant="muted">
                      <BubbleContent>{messages.patientResponse}</BubbleContent>
                    </Bubble>
                    <MessageFooter>09:25</MessageFooter>
                  </MessageContent>
                </Message>
              </MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
    </div>
  )
}

function FeedbackShowcase({ messages }: { messages: ComponentCatalogMessages }): React.JSX.Element {
  return (
    <div className="flex w-full flex-col gap-8">
      <section aria-labelledby="catalog-dialog-heading" className="flex flex-col items-start gap-4 border-b pb-8">
        <h3 className="text-sm font-semibold" id="catalog-dialog-heading">{messages.dialogHeading}</h3>
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
        <h3 className="text-sm font-semibold" id="catalog-toast-heading">{messages.operationFeedbackHeading}</h3>
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
      <section aria-labelledby="catalog-empty-heading" className="flex flex-col gap-4 border-t pt-8">
        <h3 className="text-sm font-semibold" id="catalog-empty-heading">{messages.emptyHeading}</h3>
        <Empty className="min-h-44 border">
          <EmptyHeader>
            <EmptyMedia variant="icon"><FolderSearchIcon aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{messages.emptyTitle}</EmptyTitle>
            <EmptyDescription>{messages.emptyDescription}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </section>
    </div>
  )
}

interface ComponentCatalogProps {
  embedded?: boolean
  locale?: WorkspaceLocale
}

export function ComponentCatalog({
  embedded = false,
  locale: providedLocale,
}: ComponentCatalogProps = {}): React.JSX.Element {
  const locale = providedLocale ?? readWebPreferences().locale
  const messages = getComponentCatalogMessages(locale)
  const runtime = useWebRuntime()

  useEffect(() => {
    const root = runtime.mode === 'surface'
      ? runtime.appearanceRoot.current
      : document.documentElement
    if (root !== null) root.lang = locale
  }, [locale, runtime.appearanceRoot, runtime.mode])

  return (
    <main className={cn(
      'flex flex-col bg-background text-foreground',
      embedded ? 'min-h-0 flex-1' : 'min-h-svh',
    )}>
      {embedded ? (
        <div className="flex shrink-0 justify-end border-b pb-3">
          <ThemeControl messages={messages} />
        </div>
      ) : (
        <header className="sticky top-0 z-10 flex h-[3.375rem] shrink-0 items-center border-b bg-background px-4 sm:px-6">
          <h1 className="text-base font-semibold">{messages.catalogTitle}</h1>
          <div className="ml-auto"><ThemeControl messages={messages} /></div>
        </header>
      )}
      <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 p-4 sm:p-6">
        <section aria-labelledby="catalog-controls-group-heading" className="flex flex-col gap-8">
          <h2 className="text-base font-semibold" id="catalog-controls-group-heading">{messages.controlsTab}</h2>
          <ButtonShowcase messages={messages} />
          <FormShowcase messages={messages} />
        </section>
        <section aria-labelledby="catalog-clinical-group-heading" className="flex flex-col gap-8 border-t pt-8">
          <h2 className="text-base font-semibold" id="catalog-clinical-group-heading">{messages.clinicalTab}</h2>
          <ClinicalShowcase messages={messages} />
        </section>
        <section aria-labelledby="catalog-feedback-group-heading" className="flex flex-col gap-8 border-t pt-8">
          <h2 className="text-base font-semibold" id="catalog-feedback-group-heading">{messages.feedbackTab}</h2>
          <FeedbackShowcase messages={messages} />
        </section>
        <section aria-labelledby="catalog-foundations-group-heading" className="flex flex-col gap-8 border-t pt-8">
          <h2 className="text-base font-semibold" id="catalog-foundations-group-heading">{messages.foundationsTab}</h2>
          <FoundationShowcase messages={messages} />
        </section>
        <section aria-labelledby="catalog-conversation-group-heading" className="flex flex-col gap-8 border-t pt-8">
          <h2 className="text-base font-semibold" id="catalog-conversation-group-heading">{messages.conversationTab}</h2>
          <ConversationShowcase messages={messages} />
        </section>
      </div>
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
