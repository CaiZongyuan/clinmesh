import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { dispenseQueueSchema } from '../../../packages/mod-pharmacy';
import { Badge, Button, Card, ConfirmActionButton, Field, Input, Switch } from '../../../packages/ui-kit';
import { api, errorMessage, scopeKey, words, type WorkbenchStationProps } from '../../workbench-api';

type Ticket = z.infer<typeof dispenseQueueSchema>[number];
type Selection = { orderId: string; lotId: string; quantity: number };

function Review({ ticket, language, busy, dispense }: Pick<WorkbenchStationProps, 'language'> & { ticket: Ticket; busy: boolean; dispense(lots: Selection[]): void }) {
  const text = words(language);
  const [manual, setManual] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const number = ticket.prescriptionId.slice(-8);
  const reviewed = ticket.lines.map(line => {
    let remaining = line.quantity;
    const lots = line.lots.map(lot => {
      const quantity = manual ? quantities[lot.lotId] ?? 0 : Math.min(remaining, lot.available);
      remaining -= quantity;
      return { ...lot, quantity, orderId: line.orderId };
    });
    return { ...line, lots, ready: remaining === 0 && lots.every(lot => Number.isSafeInteger(lot.quantity) && lot.quantity >= 0 && lot.quantity <= lot.available) };
  });
  const allergies = ticket.allergies;
  return <Card className="clinical-panel"><div className="cm-section-heading"><h2>{ticket.patientName}</h2><span>{number}</span></div>
    <Badge tone={allergies.status === 'confirmed' ? 'destructive' : 'info'}>{allergies.status === 'confirmed' ? `${text('Confirmed allergies', '已确认过敏')} · ${allergies.items.map(item => `${item.groupCode} (${item.reaction[language]})`).join(', ')}` : allergies.status === 'none-known' ? text('No known allergies', '无已知过敏') : text('Allergy history not obtained', '尚未询问过敏史')}</Badge>
    <Switch label={`${text('Select batches manually', '手工选择批次')} · ${number}`} checked={manual} onCheckedChange={setManual}/>
    {reviewed.map(line => <section key={line.orderId}><h3>{line.display[language]} · {line.quantity} {text('units required', '制剂单位待发')}</h3>
      <p>{line.dose} {line.doseUnit} · {line.routeCode} · {line.timesPerDay}×/{text('day', '日')} · {line.days} {text('days', '天')}</p>
      {line.lots.map(lot => <div key={lot.lotId} className="diagnosis-row"><strong>{lot.lotNumber}</strong><span>{text('Expires', '效期')} {lot.expiryDate} · {text('On hand', '可发')} {lot.available} · {lot.unit}</span>
        {manual ? <Field label={`${text('Dispense units', '本批发量')} · ${line.display[language]} · ${lot.lotNumber}`}><Input type="number" min={0} max={lot.available} value={lot.quantity ? String(lot.quantity) : ''} onValueChange={value => setQuantities({ ...quantities, [lot.lotId]: Number(value) })}/></Field> : <Badge tone="info">{text('FEFO allocation', '近效期先出')} · {lot.quantity}</Badge>}</div>)}
      {!line.ready && <p role="alert">{text('Reconcile batch quantities with the prescribed total.', '请核对批次可发余量与处方总量。')}</p>}
    </section>)}
    <ConfirmActionButton confirmation={text('Dispense the reviewed batches and quantities?', '确认按已复核的批次和数量发药？')} disabled={busy || reviewed.some(line => !line.ready)} onClick={() => dispense(reviewed.flatMap(line => line.lots.filter(lot => lot.quantity > 0).map(({ orderId, lotId, quantity }) => ({ orderId, lotId, quantity }))))}>{text('Confirm dispense', '确认发药')} · {number}</ConfirmActionButton>
  </Card>;
}

export function DispenseDesk({ workspace, language, submit }: WorkbenchStationProps) {
  const text = words(language);
  const client = useQueryClient();
  const key = scopeKey(workspace, 'pharmacy-queue', workspace.roleId);
  const query = useQuery({ queryKey: key, queryFn: ({ signal }) => api('/api/his/pharmacy/queue', dispenseQueueSchema, { signal }), refetchInterval: 5000 });
  const delivery = useMutation({ mutationFn: submit, onSettled: () => client.invalidateQueries({ queryKey: key }) });
  return <section className="clinical-panel"><div className="cm-section-heading"><h1>{text('Dispensing queue', '待发药队列')}</h1><Button onClick={() => { void query.refetch(); }}>{text('Refresh queue', '刷新队列')}</Button></div>
    {query.isError && <p role="alert">{errorMessage(query.error, language)}</p>}
    {query.data?.length === 0 && <p>{text('No prescriptions are ready to dispense.', '目前没有可发药的处方。')}</p>}
    {query.data?.map(ticket => <Review key={ticket.prescriptionId} ticket={ticket} language={language} busy={delivery.isPending} dispense={lots => delivery.mutate({ name: 'pharmacy.dispense', targetId: ticket.prescriptionId, encounterId: ticket.encounterId, version: ticket.version, fields: { lots } })}/>)}
  </section>;
}
