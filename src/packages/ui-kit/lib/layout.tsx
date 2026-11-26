import { Drawer, DrawerBackdrop, DrawerClose, DrawerContent, DrawerTitle, DrawerTrigger } from '@ui-sdk/react/drawer';
import { Meter as SdkMeter, MeterIndicator, MeterLabel, MeterTrack, MeterValue } from '@ui-sdk/react/meter';
import { useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'info' | 'success' | 'warning' | 'destructive'; children: ReactNode }) {
  return <span className="cm-badge" data-tone={tone}>{children}</span>;
}

export function Card({ children, ...props }: ComponentProps<'section'>) {
  return <section {...props} data-surface="card">{children}</section>;
}

export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  return <SdkMeter value={value} max={max}><MeterLabel>{label}</MeterLabel><MeterValue/><MeterTrack><MeterIndicator/></MeterTrack></SdkMeter>;
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

export function DetailDrawer({ title, trigger, close, children }: { title: string; trigger: string; close: string; children: ReactNode }) {
  return <Drawer side="end"><DrawerTrigger>{trigger}</DrawerTrigger><DrawerBackdrop />
    <DrawerContent className="cm-queue-drawer"><DrawerTitle>{title}</DrawerTitle>{children}<DrawerClose>{close}</DrawerClose></DrawerContent>
  </Drawer>;
}

export function WorkspaceCardLayout({ header, queueLabel, queue, children, queueVisible = true, closeQueue = 'Close queue' }: { header: ReactNode; queueLabel: string; queue: ReactNode; children: ReactNode; queueVisible?: boolean; closeQueue?: string }) {
  const workspace = useRef<HTMLDivElement>(null);
  const [desktop, setDesktop] = useState(false);
  useLayoutEffect(() => {
    const element = workspace.current!;
    const measure = () => setDesktop(element.getBoundingClientRect().width >= 800);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return <div ref={workspace} className="cm-workspace">
    <header className="cm-topbar">{header}</header>
    <div className="cm-workspace-body" data-desktop={desktop} data-queue-visible={queueVisible}>
      {desktop ? queueVisible && <aside className="cm-queue" aria-label={queueLabel}>{queue}</aside> : <div className="cm-queue-trigger">
        <Drawer side="start">
          <DrawerTrigger>{queueLabel}</DrawerTrigger><DrawerBackdrop />
          <DrawerContent className="cm-queue-drawer">
            <DrawerTitle>{queueLabel}</DrawerTitle>{queue}<DrawerClose>{closeQueue}</DrawerClose>
          </DrawerContent>
        </Drawer>
      </div>}
      <main className="cm-workspace-main" aria-label="Workspace content">{children}</main>
    </div>
  </div>;
}
