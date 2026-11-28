import { Alert, AlertDescription, AlertTitle } from '@clinmesh/ui/components/alert'
import { Button } from '@clinmesh/ui/components/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@clinmesh/ui/components/card'
import { Field, FieldGroup, FieldLabel } from '@clinmesh/ui/components/field'
import { Input } from '@clinmesh/ui/components/input'
import { PortalContainerProvider } from '@clinmesh/ui/components/portal-context'
import { Skeleton } from '@clinmesh/ui/components/skeleton'
import { Toaster } from '@clinmesh/ui/components/toast'
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type RouterHistory,
  useNavigate,
} from '@tanstack/react-router'
import { CircleAlertIcon, LogInIcon } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clinmeshMarkUrl from '../assets/clinmesh-mark.webp'
import clinmeshWordmarkUrl from '../assets/clinmesh-wordmark.webp'
import {
  ApiClientError,
  configureApiBasePath,
  getSession,
  onAuthenticationFailure,
  selectRole,
  sessionQueryKey,
  signIn,
  signOut,
} from './api-client.ts'
import { AppearanceProvider } from './appearance-context.tsx'
import { ComponentCatalog } from './component-catalog.tsx'
import { WebPreferencesProvider, useWebPreferences } from './preferences-context.tsx'
import { readWebPreferences, writeWebPreferences } from './preferences.ts'
import { RoleWorkspace } from './role-workspaces.tsx'
import { RuntimeErrorBoundary } from './runtime-error-boundary.tsx'
import { SettingsWorkspace } from './settings-workspace.tsx'
import { ChatSpace } from './spaces/chat-space.tsx'
import { PersonalAgentSpace } from './spaces/personal-agent-space.tsx'
import { ResearchSpace } from './spaces/research-space.tsx'
import { WebRuntimeProvider, type WebRuntimeOptions } from './web-runtime.tsx'
import { getWorkspaceErrorMessage, getWorkspaceErrorTitle } from './workspace-error.ts'
import { getWorkspaceMessages } from './workspace-i18n.ts'
import {
  type AppSection,
  isPlatformSpaceSection,
  isSettingsSection,
  platformSpaceRoutes,
  roleSections,
  settingsRoutes,
  WorkspaceShell,
  workspaceRoutes,
} from './workspace-shell.tsx'

function WorkspacePage({ activeSection }: { activeSection: AppSection }): React.JSX.Element {
  const { preferences, setPreferences } = useWebPreferences()
  const messages = getWorkspaceMessages(preferences.locale)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [highlightAnchor, setHighlightAnchor] = useState<string | null>(null)

  const session = useQuery({
    queryFn: ({ signal }) => getSession(signal),
    queryKey: sessionQueryKey,
    retry: false,
  })
  const roleChange = useMutation({
    mutationFn: selectRole,
    onSuccess: async nextSession => {
      queryClient.removeQueries({
        predicate: query => query.queryKey[0] !== sessionQueryKey[0],
      })
      queryClient.setQueryData(sessionQueryKey, nextSession)
      const nextSection = roleSections[nextSession.actor.roleCode]
      const nextRoute = workspaceRoutes.find(route => route.key === nextSection)
      await navigate({ replace: true, to: nextRoute?.path ?? '/' })
    },
  })
  const signOutRequest = useMutation({
    mutationFn: signOut,
    onSuccess: async () => {
      queryClient.removeQueries({
        predicate: query => query.queryKey[0] !== sessionQueryKey[0],
      })
      await navigate({ replace: true, to: '/' })
      await session.refetch()
    },
  })
  const roleCode = session.data?.actor.roleCode

  useEffect(() => {
    if (roleCode === undefined) return
    if (isSettingsSection(activeSection) || isPlatformSpaceSection(activeSection)) return
    const roleSection = roleSections[roleCode]
    if (activeSection === roleSection) return
    const roleRoute = workspaceRoutes.find(route => route.key === roleSection)
    void navigate({ replace: true, to: roleRoute?.path ?? '/' })
  }, [activeSection, navigate, roleCode])

  useEffect(() => {
    document.documentElement.lang = preferences.locale
  }, [preferences.locale])

  const handleJump = useCallback((path: string, anchor?: string) => {
    setHighlightAnchor(anchor ?? null)
    void navigate({ to: path })
  }, [navigate])

  if (session.isPending) {
    return (
      <main aria-label={messages.loading} className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-3 p-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-24 w-full" />
      </main>
    )
  }

  if (session.error instanceof ApiClientError && session.error.status === 401) {
    return <SignInScreen locale={preferences.locale} />
  }

  if (session.isError) {
    return (
      <main className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-3 p-6">
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(session.error, messages, messages.serviceError)}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(session.error, messages)}</AlertDescription>
        </Alert>
      </main>
    )
  }

  const roleSection = roleSections[session.data.actor.roleCode]
  const clinicalHomePath = workspaceRoutes.find(route => route.key === roleSection)?.path ?? '/'
  const effectiveSection: AppSection = isSettingsSection(activeSection) || isPlatformSpaceSection(activeSection)
    ? activeSection
    : activeSection === roleSection
      ? activeSection
      : roleSection

  return (
    <WorkspaceShell
      activeSection={effectiveSection}
      locale={preferences.locale}
      onJumpToSettingsAnchor={handleJump}
      onLocaleChange={locale => setPreferences(current => ({ ...current, locale }))}
      onRoleChange={practitionerRoleId => roleChange.mutate(practitionerRoleId)}
      onSignOut={() => signOutRequest.mutate()}
      onThemeChange={theme => setPreferences(current => ({ ...current, theme }))}
      roleChangePending={roleChange.isPending}
      session={session.data}
      signOutPending={signOutRequest.isPending}
      theme={preferences.theme}
    >
      {roleChange.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(roleChange.error, messages, messages.operationFailed)}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(roleChange.error, messages)}</AlertDescription>
        </Alert>
      ) : null}
      {signOutRequest.isError ? (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertTitle>{getWorkspaceErrorTitle(signOutRequest.error, messages, messages.operationFailed)}</AlertTitle>
          <AlertDescription>{getWorkspaceErrorMessage(signOutRequest.error, messages)}</AlertDescription>
        </Alert>
      ) : null}
      {isSettingsSection(effectiveSection) ? (
        <SettingsWorkspace
          activeSection={effectiveSection}
          fontSize={preferences.fontSize}
          highlightAnchor={highlightAnchor}
          locale={preferences.locale}
          onFontSizeChange={fontSize => setPreferences(current => ({ ...current, fontSize }))}
          onLocaleChange={locale => setPreferences(current => ({ ...current, locale }))}
          onThemeChange={theme => setPreferences(current => ({ ...current, theme }))}
          session={session.data}
          theme={preferences.theme}
        />
      ) : effectiveSection === 'chatSpace' ? (
        <ChatSpace
          locale={preferences.locale}
          onNavigate={path => handleJump(path)}
          session={session.data}
        />
      ) : effectiveSection === 'agentsSpace' ? (
        <PersonalAgentSpace
          clinicalHomePath={clinicalHomePath}
          locale={preferences.locale}
          onNavigate={path => handleJump(path)}
          session={session.data}
        />
      ) : effectiveSection === 'researchSpace' ? (
        <ResearchSpace
          locale={preferences.locale}
          onNavigate={path => handleJump(path)}
          session={session.data}
        />
      ) : (
        <RoleWorkspace
          activeSection={effectiveSection}
          locale={preferences.locale}
          session={session.data}
        />
      )}
    </WorkspaceShell>
  )
}

function SignInScreen({ locale }: { locale: 'en-US' | 'zh-CN' }): React.JSX.Element {
  const messages = getWorkspaceMessages(locale)
  const queryClient = useQueryClient()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const mutation = useMutation({
    mutationFn: () => signIn(email, password),
    onSuccess: async () => {
      queryClient.removeQueries({
        predicate: query => query.queryKey[0] !== sessionQueryKey[0],
      })
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey })
    },
  })

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-3 flex min-w-0 flex-col items-center gap-2 text-center">
            <div className="flex w-full items-center justify-center gap-3 bg-white px-3 py-2">
              <img alt={messages.logoAlt} className="size-14 shrink-0" src={clinmeshMarkUrl} />
              <img alt="Clinmesh" className="h-auto max-h-9 min-w-0 max-w-44" src={clinmeshWordmarkUrl} />
            </div>
            <div>
              <div className="text-sm font-semibold">{messages.appName}</div>
              <div className="text-xs text-muted-foreground">{messages.productTagline}</div>
            </div>
          </div>
          <CardTitle aria-level={1} role="heading">{messages.loginTitle}</CardTitle>
          <CardDescription>{messages.loginDescription}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            id="clinmesh-sign-in"
            onSubmit={event => {
              event.preventDefault()
              mutation.mutate()
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="clinmesh-email">{messages.emailLabel}</FieldLabel>
                <Input
                  autoComplete="username"
                  id="clinmesh-email"
                  onChange={event => setEmail(event.currentTarget.value)}
                  required
                  type="email"
                  value={email}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="clinmesh-password">{messages.passwordLabel}</FieldLabel>
                <Input
                  autoComplete="current-password"
                  data-agent-secret=""
                  id="clinmesh-password"
                  onChange={event => setPassword(event.currentTarget.value)}
                  required
                  type="password"
                  value={password}
                />
              </Field>
              {mutation.isError ? (
                <Alert variant="destructive">
                  <CircleAlertIcon aria-hidden="true" />
                  <AlertTitle>{messages.authenticationError}</AlertTitle>
                  <AlertDescription>{getWorkspaceErrorMessage(mutation.error, messages)}</AlertDescription>
                </Alert>
              ) : null}
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter>
          <Button className="ml-auto" disabled={mutation.isPending} form="clinmesh-sign-in" type="submit">
            <LogInIcon data-icon="inline-start" />
            {mutation.isPending ? messages.signingIn : messages.signIn}
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}

const rootRoute = createRootRoute({
  component: Outlet,
  notFoundComponent: () => <WorkspacePage activeSection="overview" />,
})

const routes = workspaceRoutes.map(({ key, path }) => createRoute({
  component: () => <WorkspacePage activeSection={key} />,
  getParentRoute: () => rootRoute,
  path,
}))

const platformSpaceRouteTree = platformSpaceRoutes.map(({ key, path }) => createRoute({
  component: () => <WorkspacePage activeSection={key} />,
  getParentRoute: () => rootRoute,
  path,
}))

const settingsRouteTree = settingsRoutes.map(({ key, path }) => createRoute({
  component: () => <WorkspacePage activeSection={key} />,
  getParentRoute: () => rootRoute,
  path,
}))

const componentCatalogRoute = createRoute({
  component: ComponentCatalog,
  getParentRoute: () => rootRoute,
  path: '/components',
})

const routeTree = rootRoute.addChildren([
  ...routes,
  ...platformSpaceRouteTree,
  ...settingsRouteTree,
  componentCatalogRoute,
])

export function createWebRouter(history?: RouterHistory): ReturnType<typeof createRouter<typeof routeTree>> {
  return createRouter({
    disableGlobalCatchBoundary: true,
    routeTree,
    ...(history === undefined ? {} : { history }),
  })
}

type WebRouter = ReturnType<typeof createWebRouter>

declare module '@tanstack/react-router' {
  interface Register {
    router: WebRouter
  }
}

export function createWebQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, retry: false },
      mutations: { retry: false },
    },
  })
}

interface WebAppProps {
  history?: RouterHistory
  runtime?: WebRuntimeOptions
}

function WebApplication({
  history,
  runtime: runtimeOptions = {},
}: WebAppProps = {}): React.JSX.Element {
  const [router] = useState(() => createWebRouter(history))
  const [queryClient] = useState(createWebQueryClient)
  useEffect(() => onAuthenticationFailure(error => {
    const sessionQuery = queryClient.getQueryCache().find({ queryKey: sessionQueryKey, exact: true })
    if (!sessionQuery?.state.data) return
    void queryClient.cancelQueries({ queryKey: sessionQueryKey, exact: true })
    sessionQuery.setState({ error, status: 'error', fetchStatus: 'idle' })
  }), [queryClient])
  const [preferences, setPreferences] = useState(readWebPreferences)
  const applicationRoot = useRef<HTMLDivElement>(null)
  const portalRoot = useRef<HTMLDivElement>(null)
  const [apiConfiguration] = useState(() => ({
    release: configureApiBasePath(runtimeOptions.apiBasePath ?? ''),
  }))
  useEffect(() => apiConfiguration.release, [apiConfiguration])
  const runtime = useMemo(() => ({
    appearanceRoot: applicationRoot,
    mode: 'standalone' as const,
  }), [])
  const preferencesContext = useMemo(() => ({
    preferences,
    setPreferences,
  }), [preferences])
  useEffect(() => writeWebPreferences(preferences), [preferences])

  const syncLegacyFromAppearance = useCallback((patch: {
    theme?: 'system' | 'light' | 'dark'
    fontSize?: 'standard' | 'larger' | 'large'
  }) => {
    setPreferences(current => {
      const nextTheme = patch.theme ?? current.theme
      const nextFontSize = patch.fontSize ?? current.fontSize
      if (nextTheme === current.theme && nextFontSize === current.fontSize) return current
      return { ...current, theme: nextTheme, fontSize: nextFontSize }
    })
  }, [])

  return (
    <WebPreferencesProvider value={preferencesContext}>
      <WebRuntimeProvider value={runtime}>
        <AppearanceProvider
          appRootRef={applicationRoot}
          legacyFontSize={preferences.fontSize}
          legacyTheme={preferences.theme}
          onSyncLegacyPreferences={syncLegacyFromAppearance}
        >
          <PortalContainerProvider container={portalRoot}>
            <div
              className="clinmesh-web-root"
              data-clinmesh-app="web"
              data-font-size={preferences.fontSize}
              lang={preferences.locale}
              ref={applicationRoot}
            >
              <div data-clinmesh-portal-root="" ref={portalRoot} />
              <QueryClientProvider client={queryClient}>
                <Toaster>
                  <RouterProvider router={router} />
                </Toaster>
              </QueryClientProvider>
            </div>
          </PortalContainerProvider>
        </AppearanceProvider>
      </WebRuntimeProvider>
    </WebPreferencesProvider>
  )
}

export function WebApp(props: WebAppProps = {}): React.JSX.Element {
  return <RuntimeErrorBoundary><WebApplication {...props} /></RuntimeErrorBoundary>
}

export type { WebRuntimeOptions } from './web-runtime.tsx'
