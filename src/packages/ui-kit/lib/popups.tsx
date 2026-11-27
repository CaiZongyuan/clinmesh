import { AlertDialog as SdkAlertDialog, AlertDialogBackdrop, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger } from '@ui-sdk/react/alert-dialog';
import { Dialog as SdkDialog, DialogBackdrop, DialogClose, DialogContent, DialogTitle, DialogTrigger } from '@ui-sdk/react/dialog';
import { Menu as SdkMenu, MenuContent, MenuItem, MenuTrigger } from '@ui-sdk/react/menu';
import { Tabs as SdkTabs, TabsList, TabsPanel, TabsTab } from '@ui-sdk/react/tabs';
import { createToaster, Toast, ToastAction, ToastClose, ToastDescription, ToastRegion, ToastTitle, type Toaster } from '@ui-sdk/react/toast';
import { createContext, useContext, useEffect, useState, type ComponentProps, type ReactNode } from 'react';

export function Dialog({ title, triggers, children, close, keepMounted = triggers.length > 1, ...control }: {
  title: string; triggers: string[]; children: ReactNode; close: string; keepMounted?: boolean;
} & Pick<ComponentProps<typeof SdkDialog>, 'open' | 'onOpenChange'>) {
  return <SdkDialog {...control}>
    {triggers.map(label => <DialogTrigger key={label}>{label}</DialogTrigger>)}
    <DialogBackdrop />
    <DialogContent keepMounted={keepMounted}>
      <DialogTitle>{title}</DialogTitle>
      {children}
      <DialogClose>{close}</DialogClose>
    </DialogContent>
  </SdkDialog>;
}

export function AlertDialog({ title, trigger, confirmation, confirm, cancel, onConfirm }: {
  title: string; trigger: string; confirmation: string; confirm: string; cancel: string; onConfirm: () => void | Promise<void>;
}) {
  return <SdkAlertDialog>
    <AlertDialogTrigger>{trigger}</AlertDialogTrigger>
    <AlertDialogBackdrop />
    <AlertDialogContent>
      <AlertDialogTitle>{title}</AlertDialogTitle>
      <AlertDialogDescription>{confirmation}</AlertDialogDescription>
      <div className="cm-actions">
        <AlertDialogClose>{cancel}</AlertDialogClose>
        <AlertDialogClose value="confirm" action={onConfirm} data-agent-confirm={confirmation.trim() || title} data-variant="solid">{confirm}</AlertDialogClose>
      </div>
    </AlertDialogContent>
  </SdkAlertDialog>;
}

export function Menu({ label, items, onAction }: {
  label: string; items: { value: string; label: string }[]; onAction: NonNullable<ComponentProps<typeof SdkMenu>['onAction']>;
}) {
  return <SdkMenu onAction={onAction}>
    <MenuTrigger>{label}</MenuTrigger>
    <MenuContent>{items.map(item => <MenuItem key={item.value} value={item.value}>{item.label}</MenuItem>)}</MenuContent>
  </SdkMenu>;
}

export function Tabs({ label, items, ...props }: Pick<ComponentProps<typeof SdkTabs>, 'value' | 'defaultValue' | 'onValueChange'> & {
  label: string; items: { value: string; label: string; content: ReactNode }[];
}) {
  return <SdkTabs {...props} aria-label={label}>
    <TabsList aria-label={label}>{items.map(item => <TabsTab key={item.value} value={item.value}>{item.label}</TabsTab>)}</TabsList>
    {items.map(item => <TabsPanel key={item.value} value={item.value}>{item.content}</TabsPanel>)}
  </SdkTabs>;
}

const ToastContext = createContext<Toaster<ReactNode> | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toaster] = useState(() => createToaster());
  useEffect(() => () => { toaster.dismiss(); }, [toaster]);
  return <ToastContext.Provider value={toaster}>
    {children}
    <ToastRegion toaster={toaster} aria-label="Notifications">{() => <Toast>
      <div><ToastTitle /><ToastDescription /></div>
      <ToastAction /><ToastClose aria-label="Dismiss notification" />
    </Toast>}</ToastRegion>
  </ToastContext.Provider>;
}

export function useToast() {
  const toaster = useContext(ToastContext);
  if (!toaster) throw new Error('useToast requires ToastProvider');
  return toaster;
}
