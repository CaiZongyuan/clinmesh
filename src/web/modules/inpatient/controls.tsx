import { z } from 'zod';
import { directorySchema, type WardView } from '../../../packages/mod-inpatient';
import { ConfirmActionButton, Field, Input, Select } from '../../../packages/ui-kit';
import { type Intent, type WorkbenchStationProps } from '../../workbench-api';

export type Directory = z.infer<typeof directorySchema>;
export type Commands = WorkbenchStationProps & { directory: Directory; busy: boolean; allowed(name: string): boolean; run(intent: Intent): Promise<unknown> };
export type StageProps = Commands & { ward: WardView };
export type Option = { value: string; label: string };
export function Choice({ label, value, options, change }: { label: string; value: string; options: Option[]; change(value: string): void }) {
  return <Field label={label}><Select value={value || null} options={options} onValueChange={value => { if (value) change(value); }}/></Field>;
}
export function Entry({ label, value, change }: { label: string; value: string; change(value: string): void }) { return <Field label={label}><Input value={value} onValueChange={change}/></Field>; }
export function Action({ commands, name, label, targetId, version, fields, disabled = false, done }: { commands: Commands; name: string; label: string; targetId: string; version: number; fields?: Record<string, unknown>; disabled?: boolean; done?(receipt: unknown): void }) {
  if (!commands.allowed(name)) return null;
  return <ConfirmActionButton confirmation={label} disabled={commands.busy || disabled} onClick={() => { void commands.run({ name, targetId, version, fields }).then(done, () => {}); }}>{label}</ConfirmActionButton>;
}
export function WardAction({ panel, name, ...props }: Omit<Parameters<typeof Action>[0], 'commands' | 'targetId' | 'version'> & { panel: StageProps }) {
  return <Action {...props} commands={panel} name={`ward.${name}`} targetId={panel.ward.encounterId} version={panel.ward.version}/>;
}
export const namedOptions = (values: string[]) => values.map(value => ({ value, label: value }));
export const selected = (value: string, options: Option[]) => options.some(option => option.value === value) ? value : options[0]?.value ?? '';
