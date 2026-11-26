import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { formatMinor, parseMinor, previewSchema, type BillingAccount } from '../../../packages/mod-billing';
import { Badge, Button, Card, Checkbox, ConfirmActionButton, Dialog, Field, Input, Select, Table } from '../../../packages/ui-kit';
import { words, type Language } from '../../workbench-api';
import type { CashierAction } from './use-cashier';

type Props = { bill: BillingAccount; language: Language; busy: boolean; act: CashierAction; children?: ReactNode };
type Preview = z.infer<typeof previewSchema>;
const confirms = { collection: 'payment.confirm', refund: 'refund.allocation.confirm', deposit: 'inpatient.deposit.confirm', 'deposit-refund': 'inpatient.refund.confirm', settlement: 'inpatient.discharge.settle' } as const;
const methods = ['cash', 'card', 'mobile'] as const;

export function CashierDesk({ bill, language, busy, act, children }: Props) {
  const text = words(language);
  const money = (value: number) => formatMinor(value, bill.currency);
  const [checked, setChecked] = useState<string[]>([]);
  const [entered, setEntered] = useState('');
  const [channels, setChannels] = useState({ cash: '', card: '', mobile: '' });
  const [reason, setReason] = useState('');
  const [selectedCharge, setSelectedCharge] = useState('');
  const [source, setSource] = useState('');
  const [correction, setCorrection] = useState('');
  const [direction, setDirection] = useState<'credit' | 'debit'>('credit');
  const [simulation, setSimulation] = useState('approved');
  const [review, setReview] = useState<Preview | null>(null);
  const [validation, setValidation] = useState('');
  const inpatient = bill.encounterClass === 'inpatient';
  const eligible = bill.charges.filter(line => !line.cancelled && !line.pending && line.outstandingMinor > 0);
  const selected = eligible.filter(line => checked.includes(line.id));
  const selectedId = bill.charges.some(line => line.id === selectedCharge) ? selectedCharge : bill.charges[0]?.id ?? '';
  const origins = bill.payments.filter(payment => payment.status === 'succeeded' && (inpatient ? payment.kind === 'deposit' : payment.kind === 'collection' && payment.allocations.some(line => line.chargeId === selectedId)));
  const originalId = origins.find(payment => payment.id === source)?.id ?? origins[0]?.id ?? '';
  const amountMinor = () => parseMinor(entered, bill.currency);
  const tenderFields = (): Record<string, z.core.util.JSONType> => {
    const tenders = methods.flatMap(method => channels[method] ? [{ method, amountMinor: parseMinor(channels[method], bill.currency) }] : []);
    return tenders.length ? { tenders } : {};
  };
  const execute = (task: () => Promise<unknown>) => { setValidation(''); void Promise.resolve().then(task).catch(error => setValidation(error instanceof Error ? error.message : 'INVALID_INPUT')); };
  const preview = (name: string, fields: Parameters<CashierAction>[1]) => execute(async () => setReview(previewSchema.parse(await act(name, fields))));
  const reviewButton = (name: string, getFields: () => Parameters<CashierAction>[1], label: string, disabled: boolean) => <Button disabled={busy || disabled} onClick={() => execute(async () => setReview(previewSchema.parse(await act(name, getFields()))))}>{label}</Button>;
  const confirm = (name: string, fields: () => Parameters<CashierAction>[1], label: string, disabled = false) => <ConfirmActionButton disabled={busy || disabled} confirmation={label} onClick={() => execute(async () => { await act(name, fields()); setReview(null); })}>{label}</ConfirmActionButton>;
  const channelNames = { cash: text('Cash', '现金'), card: text('Card', '银行卡'), mobile: text('Mobile', '移动支付') };
  const channelLabel = (method: string) => Object.hasOwn(channelNames, method) ? channelNames[method as keyof typeof channelNames] : method;
  const openCorrections = bill.corrections.filter(item => item.remainingMinor);
  const correctionId = openCorrections.find(item => item.id === correction)?.id ?? openCorrections[0]?.id;
  const correctionFields: Record<string, string> = correctionId ? { correctionId } : {};
  const statusNames = { succeeded: text('Succeeded', '成功'), unknown: text('Awaiting recovery', '资金结果未知'), declined: text('Declined', '拒付') };
  const kindNames = { collection: text('Collection', '收款'), refund: text('Allocation refund', '逐分配退款'), deposit: text('Deposit / top-up', '预交金／补缴'), 'deposit-refund': text('Deposit refund', '住院退款'), settlement: text('First settlement', '首次封账') };
  const locked = bill.policy === 'free';
  return <div className="clinical-panel"><Card><h3>{text('Account balance', '账务余额')}</h3><p>{text('Net charges', '净应收')} {money(bill.netMinor)} · {text('Covered', '第三方覆盖')} {money(bill.coverageMinor)} · {text('Net received', '净实收')} {money(bill.cashMinor)}</p>
    <strong>{bill.pending ? text('Funds unresolved', '资金状态待查') : bill.payerPending ? text('Coverage needs review', '第三方覆盖待复核') : money(bill.balanceMinor)}</strong> {locked && <Badge>{text('Free care', '免费机构')}</Badge>}
    {bill.settlement && <p>{text('Frozen at first settlement', '首次结算冻结额')} {money(bill.settlement.netMinor)}</p>}
  </Card><Table caption={text('Charge items', '费用明细')}><thead><tr><th>{text('Charge', '费用')}</th><th>{text('Net amount', '净额')}</th><th>{text('Outstanding', '待收')}</th></tr></thead><tbody>{bill.charges.map(line => <tr key={line.id}><td>{!inpatient && eligible.includes(line) ? <Checkbox label={`${line.description} · ${line.id.slice(-6)}`} checked={checked.includes(line.id)} onCheckedChange={value => setChecked(previous => value ? [...previous, line.id] : previous.filter(id => id !== line.id))}/> : line.description}</td><td>{money(line.netMinor)}</td><td>{line.pending ? statusNames.unknown : money(line.outstandingMinor)}</td></tr>)}</tbody></Table>
    {!locked && <><Field label={text('Amount', '本次金额')} description={text(`Use ${bill.currency.code} with ${bill.currency.minorUnitExponent} decimal places.`, `币种 ${bill.currency.code}，小数位数 ${bill.currency.minorUnitExponent}。`)}><Input inputMode="decimal" value={entered} onValueChange={setEntered}/></Field>
      <Dialog title={text('Payment methods', '支付方式')} triggers={[text('Split payment', '组合支付')]} close={text('Done', '完成')}>{methods.map(method => <Field key={method} label={channelNames[method]}><Input value={channels[method]} inputMode="decimal" onValueChange={value => setChannels(previous => ({ ...previous, [method]: value }))}/></Field>)}</Dialog>
      <Field label={text('Simulated channel response', '仿真渠道响应')}><Select value={simulation} options={[{ value: 'approved', label: statusNames.succeeded }, { value: 'declined', label: statusNames.declined }, { value: 'delayed-approval', label: text('Delayed approval', '延迟查明成功') }, { value: 'delayed-decline', label: text('Delayed decline', '延迟查明拒付') }]} onValueChange={value => { if (value) setSimulation(value); }}/></Field>
      {bill.settlement && <Field label={text('Correction to reconcile', '待结清更正')}><Select value={correctionId ?? ''} options={openCorrections.map(item => ({ value: item.id, label: `${item.reason} · ${money(item.remainingMinor)} · ${item.id.slice(-6)}` }))} onValueChange={value => { if (value) setCorrection(value); }}/></Field>}
      {inpatient ? reviewButton('inpatient.deposit.preview', () => ({ amountMinor: amountMinor(), ...tenderFields(), ...correctionFields, simulation }), text('Preview deposit / top-up', '预览预交金／补缴'), !entered || bill.pending || bill.payerPending) : <Dialog title={text('Review selected charges', '复核所选费用')} triggers={[text('Collect selected charges', '合并收款')]} close={text('Close', '关闭')}><ul>{selected.map(line => <li key={line.id}>{line.description} · {money(line.outstandingMinor)}</li>)}</ul>{reviewButton('payment.preview', () => ({ chargeIds: selected.map(line => line.id), ...(entered ? { amountMinor: amountMinor() } : {}), ...tenderFields(), simulation }), text('Freeze payment preview', '冻结收款预览'), !selected.length || selected.length > 20)}</Dialog>}
      <Card><h3>{text('Adjustments and refunds', '费用冲减与退款')}</h3><Field label={text('Charge to adjust', '目标费用')}><Select value={selectedId} options={bill.charges.map(line => ({ value: line.id, label: `${line.description} · ${line.id.slice(-6)}` }))} onValueChange={value => { if (value) setSelectedCharge(value); }}/></Field>
        <Field label={text('Reason', '调整或退款原因')}><Input value={reason} onValueChange={setReason}/></Field>
        {bill.settlement && <Field label={text('Correction direction', '更正方向')}><Select value={direction} options={[{ value: 'credit', label: text('Reduce charge', '冲减') }, { value: 'debit', label: text('Add charge', '补计') }]} onValueChange={value => { if (value) setDirection(value); }}/></Field>}
        {confirm(bill.settlement ? 'inpatient.correction' : 'charge.adjust', () => ({ chargeId: selectedId, amountMinor: amountMinor() * (bill.settlement && direction === 'credit' ? -1 : 1), reason }), bill.settlement ? text('Confirm post-settlement correction', '确认结算后更正') : text('Confirm charge reduction', '确认费用冲减'), !selectedId || !entered || !reason.trim() || bill.pending)}
        <Field label={text('Original payment', '原款交易')}><Select value={originalId} options={origins.map(payment => ({ value: payment.id, label: `${money(payment.amountMinor)} · ${payment.id.slice(-8)}` }))} onValueChange={value => { if (value) setSource(value); }}/></Field>
        {reviewButton(inpatient ? 'inpatient.refund.preview' : 'refund.allocation.preview', () => ({ paymentId: originalId, ...(!inpatient && { chargeId: selectedId }), ...correctionFields, amountMinor: amountMinor(), reason, simulation }), text('Preview original-method refund', '预览原路退款'), !originalId || !entered || !reason.trim() || bill.pending || bill.payerPending)}
      </Card>
      {inpatient && !bill.settlement && <Button disabled={busy || bill.pending || bill.balanceMinor !== 0 || bill.admissionStatus !== 'departed'} onClick={() => preview('inpatient.settlement.preview', {})}>{text('Preview first settlement', '预览首次封账')}</Button>}
      {review && <Card><h3>{kindNames[review.kind]}</h3><p>{money(review.amountMinor)} · {text('Valid until', '有效至')} {review.expiresAt}</p>{review.tenders.map(channel => <p key={channel.method}>{channelLabel(channel.method)} · {money(channel.amountMinor)}</p>)}{review.review?.charges.map(line => <p key={line.id}>{line.description} · {line.businessDay} · {line.quantity} × {money(line.unitPriceMinor)} · {text('Net / covered / paid', '净额／覆盖／实收')} {[line.netMinor, line.coverageMinor, line.netPaidMinor].map(money).join(' / ')} · {text('This allocation', '本次分配')} {money(review.allocations.find(item => item.chargeId === line.id)?.amountMinor ?? 0)}</p>)}{review.kind === 'settlement' && review.review && <><p>{text('Net charges / covered / cash / balance', '净应收／覆盖／净入金／差额')} · {[review.review.netMinor, review.review.coverageMinor, review.review.cashMinor, review.review.balanceMinor].map(money).join(' / ')}</p>{review.review.payments.map(payment => <p key={payment.id}>{kindNames[payment.kind]} · {payment.id.slice(-8)} · {money(payment.amountMinor)} · {statusNames[payment.status]}</p>)}</>}{confirm(confirms[review.kind], () => ({ commitToken: review.commitToken }), text('Confirm frozen preview', '确认冻结预览'), inpatient && review.version !== bill.version)}<Button onClick={() => setReview(null)}>{text('Discard preview', '放弃预览')}</Button></Card>}
    </>}
    <Card><h3>{text('Payment history', '支付历史')}</h3>{!bill.payments.length && <p>{text('No payment attempts.', '暂无收退款记录。')}</p>}{bill.payments.toReversed().map(payment => <div key={payment.id}><p>{kindNames[payment.kind]} · {money(payment.amountMinor)} · {statusNames[payment.status]} · {payment.id.slice(-8)}</p>{payment.status === 'unknown' && confirm('payment.recover', () => ({ paymentId: payment.id, paymentVersion: payment.version }), `${text('Recover original attempt', '查明原资金尝试')} · ${payment.id.slice(-8)}`)}</div>)}</Card>
    {validation && <p role="alert">{validation}</p>}{children}
  </div>;
}
