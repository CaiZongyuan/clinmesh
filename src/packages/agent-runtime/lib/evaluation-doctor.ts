import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry, hook, ToolTask, type ToolRegistration } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { CoreError } from '../../platform';
import type { StorePort, StoreScope } from '../../store';
import { clinicianTool } from './clinician-assistant';
import { clinicianModel, clinicianModels } from './clinician-model';
import type { AgentProvider } from './configuration';
import { openDurableAgentSession } from './session';

const tools = {
  ask_patient: z.strictObject({ question: z.string().min(1).max(2000) }),
  investigate: z.strictObject({ serviceId: z.uuidv7(), priorSurgeryId: z.string().min(1).optional() }),
  read_report: z.strictObject({ reportId: z.uuidv7(), reportVersion: z.int().positive() }),
  acknowledge_report: z.strictObject({ reportId: z.uuidv7(), reportVersion: z.int().positive(), mode: z.enum(['text', 'frames-unavailable']) }),
  diagnose: z.strictObject({ codeSystem: z.string(), code: z.string().min(1) }),
  prescribe: z.strictObject({ codeSystem: z.string(), code: z.string(), dose: z.number().positive(), routeCode: z.string(), timesPerDay: z.int().positive(), days: z.int().positive(), quantity: z.int().positive() }),
  no_medication: z.strictObject({ reason: z.string().trim().min(1) }),
  sign_record: z.strictObject({ fields: z.array(z.strictObject({ id: z.string(), text: z.string().min(1).max(4000) })).min(1).max(24) }),
  complete: z.strictObject({}),
};
export type EvaluationAction = { [Name in keyof typeof tools]: { name: Name; args: z.infer<typeof tools[Name]> } }[keyof typeof tools];
const descriptions: Record<keyof typeof tools, string> = { ask_patient: 'Ask the isolated Patient Agent one question.', investigate: 'Order and execute an available service. Returns a signed report identifier and version.', read_report: 'Read the specified version of a signed report before deciding whether to acknowledge it.', acknowledge_report: 'Explicitly acknowledge a report version you reviewed. Use frames-unavailable if required frames could not be reviewed.', diagnose: 'Confirm the primary diagnosis from the available catalog.', prescribe: 'Issue one reviewed prescription using the safety-checked catalog.', no_medication: 'Record the explicit reason for no medication.', sign_record: 'Save and sign a record with the given template field IDs.', complete: 'Complete this encounter if the clinical gates pass.' };
const input = z.object({ opening: z.string(), priorHistory: z.object({ surgeries: z.array(z.object({ id: z.string() })).optional() }).loose(), template: z.array(z.string()), diagnoses: z.array(z.object({ codeSystem: z.string(), code: z.string(), name: z.string() })), services: z.array(z.object({ id: z.uuidv7(), kind: z.enum(['lab', 'imaging', 'pathology']), code: z.string(), name: z.string() })), drugs: z.array(z.object({ codeSystem: z.string(), code: z.string(), name: z.string(), dose: z.number(), routeCode: z.string() })) });
export type EvaluationPresentation = z.infer<typeof input>;
const mockDoctor: FauxResponseFactory = transcript => {
  const question = transcript.messages.find(message => message.role === 'user');
  const content = typeof question?.content === 'string' ? question.content : question?.content.find(block => block.type === 'text')?.text;
  const visible = input.parse(JSON.parse(content ?? '{}'));
  const results = transcript.messages.filter(message => message.role === 'toolResult');
  const seen = (name: string) => results.some(result => result.toolName === name);
  const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
  if (!seen('ask_patient')) return tool('ask_patient', { question: 'How did your symptoms begin, and are you allergic to any medicines?' });
  const surgery = visible.priorHistory.surgeries?.[0];
  const diagnosis = /cough|咳/.test(visible.opening) ? visible.diagnoses.find(item => /pneumonia/i.test(item.name)) : surgery && visible.diagnoses.find(item => /follow.up/i.test(item.name));
  if (!diagnosis) return fauxAssistantMessage('This teaching script has insufficient evidence to complete the encounter.');
  if (!seen('diagnose')) return tool('diagnose', { codeSystem: diagnosis.codeSystem, code: diagnosis.code });
  const latest = results.at(-1);
  const output = latest?.content.find(block => block.type === 'text')?.text;
  if (!latest?.isError && output && latest?.toolName === 'investigate') { const report = tools.read_report.strip().parse(JSON.parse(output)); return tool('read_report', report); }
  if (!latest?.isError && output && latest?.toolName === 'read_report') {
    const reviewed = z.object({ report: z.object({ id: z.uuidv7(), version: z.int() }), reviewMode: z.enum(['text', 'frames-unavailable']) }).parse(JSON.parse(output));
    return tool('acknowledge_report', { reportId: reviewed.report.id, reportVersion: reviewed.report.version, mode: reviewed.reviewMode });
  }
  const ordered = new Set(transcript.messages.filter(item => item.role === 'assistant').flatMap(item => item.content.filter(block => block.type === 'toolCall' && block.name === 'investigate').map(block => block.type === 'toolCall' && block.arguments.serviceId)));
  const next = visible.services.find(service => !ordered.has(service.id) && (surgery ? (service.kind === 'pathology' || /chest CT/i.test(service.name)) : /blood count/i.test(service.name)));
  if (next) return tool('investigate', { serviceId: next.id, ...(surgery && next.kind === 'pathology' && { priorSurgeryId: surgery.id }) });
  const drug = visible.drugs.find(item => item.name === 'Doxycycline');
  if (drug && !seen('prescribe')) return tool('prescribe', { codeSystem: drug.codeSystem, code: drug.code, dose: drug.dose, routeCode: drug.routeCode, timesPerDay: 2, days: 5, quantity: 10 });
  if (!seen('sign_record')) {
    const report = results.find(item => item.toolName === 'read_report')?.content.find(item => item.type === 'text')?.text;
    const note: Record<string, string> = { concern: visible.opening, subjective: results.find(item => item.toolName === 'ask_patient')?.content.find(item => item.type === 'text')?.text ?? visible.opening, objective: report ?? 'Clinical observations reviewed.', assessment: diagnosis.name, plan: drug ? `Review response to ${drug.name} and return if symptoms worsen.` : 'Review the clinical course.' };
    return tool('sign_record', { fields: visible.template.map(id => ({ id, text: note[id] ?? 'Reassess symptoms at follow-up.' })) });
  }
  if (!seen('complete')) return tool('complete', {});
  return fauxAssistantMessage('Encounter reviewed.');
};

export async function runEvaluationDoctor(store: StorePort, at: StoreScope, sessionId: string, config: AgentProvider, presentation: EvaluationPresentation, maxTurns: number, execute: (action: EvaluationAction, delivered: ReadonlySet<string>) => Promise<unknown>, signal: AbortSignal, enabled: ReadonlySet<string>, reads: ToolRegistration[], rejected: (name: string, fields: string[], code: string) => void) {
  const context = BACKGROUND_CONTEXT;
  let turns = 0;
  const delivered = new Set<string>();
  const visibleReport = z.object({ report: z.object({ id: z.uuidv7(), version: z.int().positive() }) });
  const model = clinicianModels(config, mockDoctor, signal, () => {}, async transcript => {
    if (signal.aborted) throw new CoreError(409, 'EVALUATION_STOPPED');
    turns++;
    for (const message of transcript.messages) {
      if (message.role !== 'toolResult' || message.toolName !== 'read_report' || message.isError) continue;
      const text = message.content.find(block => block.type === 'text')?.text;
      try { const parsed = visibleReport.safeParse(JSON.parse(text ?? 'null')); if (parsed.success) delivered.add(`${parsed.data.report.id}/${parsed.data.report.version}`); } catch {}
    }
  });
  const registry = createRegistry();
  const offered = [...reads, ...Object.entries(tools).filter(([name]) => enabled.has(name)).map(([name, schema]) => clinicianTool(name, descriptions[name as keyof typeof tools], schema, async args => execute({ name, args } as EvaluationAction, delivered), true))];
  registry.install({ name: 'evaluation', tools: offered, hooks: [hook(ToolTask, { afterTool(call, result) {
    const reason = result.diagnostics?.find(diagnostic => ['invalid_arguments', 'tool_unavailable'].includes(diagnostic.code ?? ''));
    if (reason) {
      const known = offered.some(tool => tool.name === call.name);
      const schema = Object.hasOwn(tools, call.name) ? tools[call.name as keyof typeof tools] : undefined;
      const fields = schema ? Object.keys(call.arguments).filter(key => Object.hasOwn(schema.shape, key)) : [];
      rejected(known ? call.name : 'unavailable_tool', fields, reason.code === 'invalid_arguments' ? 'INVALID_TOOL_ARGUMENTS' : 'TOOL_UNAVAILABLE');
    }
    return result;
  } })] });
  const harness = await openDurableAgentSession(store, at, sessionId, 'clinician', { models: model.models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false } } });
  try {
    const doctor = await harness.root(context, { agent: { model: { provider: clinicianModel.provider, modelId: clinicianModel.id }, maxTurns, instructions: 'You are the tested clinician in an isolated synthetic Evaluation Run. Use the provided tools to ask the patient, choose actual investigations, confirm a diagnosis, decide medication, sign the complete record and finish the encounter. Use only visible facts, catalog entries and returned reports.' } });
    const submission = await doctor.submit({ type: 'input', content: JSON.stringify(presentation), requestId: sessionId }, context);
    const settled = await submission.wait(context);
    const usage = Object.values((await harness.usage(context)).models);
    return { turns, inputTokens: usage.reduce((sum, value) => sum + value.input, 0), outputTokens: usage.reduce((sum, value) => sum + value.output, 0), error: model.failure()?.code ?? (settled.status !== 'done' ? 'EVALUATION_INTERRUPTED' : null) };
  } finally { await harness.close(context); }
}
