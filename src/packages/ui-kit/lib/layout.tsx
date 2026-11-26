import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from '@ui-sdk/react/drawer';
import { useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'info' | 'success' | 'warning' | 'destructive'; children: ReactNode }) {
  return <span className="cm-badge" data-tone={tone}>{children}</span>;
}

export function Card({ children, ...props }: ComponentProps<'section'>) {
  return <section {...props} data-surface="card">{children}</section>;
}

export function Table({ caption, children }: { caption: string; children: ReactNode }) {
  return <div className="cm-table-scroll"><table className="cm-table"><caption>{caption}</caption>{children}</table></div>;
}

export function AgentGlowRegion({ active = false, draft = false, children }: { active?: boolean; draft?: boolean; children: ReactNode }) {
  return <div className="cm-agent-region" data-agent-active={active} data-agent-draft={draft}>{children}</div>;
}

export function AgentPanelShell({ title, status, children }: { title: string; status?: ReactNode; children: ReactNode }) {
  return <aside className="cm-agent-panel" aria-label={title}>
    <header className="cm-section-heading"><h2>{title}</h2>{status}</header>
    {children}
  </aside>;
}

const desktopQuery = '(min-width: 800px)';
function subscribeWidth(notify: () => void) {
  const viewport = window.matchMedia(desktopQuery);
  viewport.addEventListener('change', notify);
  return () => viewport.removeEventListener('change', notify);
}

export function WorkspaceCardLayout({ header, queueLabel, queue, children }: { header: ReactNode; queueLabel: string; queue: ReactNode; children: ReactNode }) {
  const desktop = useSyncExternalStore(subscribeWidth, () => window.matchMedia(desktopQuery).matches, () => false);
  return <div className="cm-workspace">
    <header className="cm-topbar">{header}</header>
    <div className="cm-workspace-body" data-desktop={desktop}>
      {desktop ? <aside className="cm-queue" aria-label={queueLabel}>{queue}</aside> : <div className="cm-queue-trigger">
        <Drawer side="start">
          <DrawerTrigger>{queueLabel}</DrawerTrigger><DrawerBackdrop />
          <DrawerContent className="cm-queue-drawer">
            <DrawerTitle>{queueLabel}</DrawerTitle>{queue}<DrawerClose>Close queue</DrawerClose>
          </DrawerContent>
        </Drawer>
      </div>}
      <main className="cm-workspace-main" aria-label="Workspace content">{children}</main>
    </div>
  </div>;
}
