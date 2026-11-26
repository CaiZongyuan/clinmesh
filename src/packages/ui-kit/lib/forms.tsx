import { Button } from '@ui-sdk/react/button';
import { Checkbox as SdkCheckbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Field as SdkField, FieldDescription, FieldError, FieldLabel } from '@ui-sdk/react/field';
import { NumberInput as SdkNumberInput, NumberInputControl, NumberInputDecrement, NumberInputGroup, NumberInputIncrement } from '@ui-sdk/react/number-input';
import { Select as SdkSelect, SelectContent, SelectItem, SelectItemIndicator, SelectTrigger, SelectValue, type SelectProps } from '@ui-sdk/react/select';
import { Switch as SdkSwitch, SwitchThumb } from '@ui-sdk/react/switch';
import type { ComponentProps, ReactNode } from 'react';

export function IconButton({ label, ...props }: ComponentProps<typeof Button> & { label: string }) {
  return <Button {...props} aria-label={label} />;
}

interface FieldProps extends Omit<ComponentProps<typeof SdkField>, 'children'> {
  label: string;
  description?: string;
  error?: string;
  children: ReactNode;
}

export function Field({ label, description, error, children, ...props }: FieldProps) {
  return <SdkField {...props} invalid={error ? true : props.invalid}>
    <FieldLabel>{label}</FieldLabel>
    {children}
    {description && <FieldDescription>{description}</FieldDescription>}
    {error && <FieldError>{error}</FieldError>}
  </SdkField>;
}

export function NumberInput(props: Omit<ComponentProps<typeof SdkNumberInput>, 'children'>) {
  return <SdkNumberInput {...props}>
    <NumberInputGroup>
      <NumberInputDecrement aria-label="Decrease value" />
      <NumberInputControl />
      <NumberInputIncrement aria-label="Increase value" />
    </NumberInputGroup>
  </SdkNumberInput>;
}

export function Select<Value extends string>({ options, ...props }: Omit<Extract<SelectProps<Value>, { multiple?: false }>, 'items' | 'children'> & {
  options: { value: Value; label: string }[];
}) {
  return <SdkSelect<Value> {...props} items={options}>
    <SelectTrigger><SelectValue /></SelectTrigger>
    <SelectContent>{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}<SelectItemIndicator aria-hidden /></SelectItem>)}</SelectContent>
  </SdkSelect>;
}

export function Checkbox({ label, ...props }: ComponentProps<typeof SdkCheckbox> & { label: string }) {
  return <label className="cm-choice"><SdkCheckbox {...props} aria-label={label}><CheckboxIndicator /></SdkCheckbox>{label}</label>;
}

export function Switch({ label, ...props }: ComponentProps<typeof SdkSwitch> & { label: string }) {
  return <label className="cm-choice"><SdkSwitch {...props} aria-label={label}><SwitchThumb /></SdkSwitch>{label}</label>;
}
