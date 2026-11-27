import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
import { createRegistry } from '@earendil-works/pi-durable';
import { z } from 'zod';
import { CoreError } from '../../platform';
import type { StorePort, StoreScope } from '../../store';
import { clinicianTool } from './clinician-assistant';
import { clinicianModel, clinicianModels } from './clinician-model';
import type { AgentProvider } from './configuration';
import { openDurableAgentSession } from './session';

const tools = {
  ask_patient: z.strictObject({ question: z.string().min(1).max(2000) }),
  investigate: z.strictObject({ serviceCode: z.string().min(1) }),
  diagnose: z.strictObject({ codeSystem: z.string(), code: z.string().min(1) }),
  prescribe: z.strictObject({ codeSystem: z.string(), code: z.string(), dose: z.number().positive(), routeCode: z.string(), timesPerDay: z.int().positive(), days: z.int().positive(), quantity: z.int().positive() }),
  no_medication: z.strictObject({ reason: z.string().trim().min(1) }),
  sign_record: z.strictObject({ fields: z.array(z.strictObject({ id: z.string(), text: z.string().min(1).max(4000) })).min(1).max(24) }),
  complete: z.strictObject({}),
};
export type EvaluationAction = { [Name in keyof typeof tools]: { name: Name; args: z.infer<typeof tools[Name]> } }[keyof typeof tools];
const descriptions: Record<keyof typeof tools, string> = { ask_patient: 'Ask the isolated Patient Agent one question.', investigate: 'Issue a catalog investigation, obtain the authored report and acknowledge it.', diagnose: 'Confirm the primary diagnosis from the available catalog.', prescribe: 'Issue one reviewed prescription using the safety-checked catalog.', no_medication: 'Record the explicit reason for no medication.', sign_record: 'Save and sign a record with the given template field IDs.', complete: 'Complete this encounter if the clinical gates pass.' };
const input = z.object({ opening: z.string(), template: z.array(z.string()), diagnoses: z.array(z.object({ codeSystem: z.string(), code: z.string(), name: z.string() })), services: z.array(z.object({ code: z.string(), name: z.string() })), drugs: z.array(z.object({ codeSystem: z.string(), code: z.string(), name: z.string(), dose: z.number(), routeCode: z.string() })) });
export type EvaluationPresentation = z.infer<typeof input>;
const mockDoctor: FauxResponseFactory = transcript => {
  const question = transcript.messages.find(message => message.role === 'user');
  const content = typeof question?.content === 'string' ? question.content : question?.content.find(block => block.type === 'text')?.text;
  const visible = input.parse(JSON.parse(content ?? '{}'));
  const results = transcript.messages.filter(message => message.role === 'toolResult');
  const seen = (name: string) => results.some(result => result.toolName === name);
  const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' });
  if (!seen('ask_patient')) return tool('ask_patient', { question: 'How did your symptoms begin, and are you allergic to any medicines?' });
  const diagnosis = /cough|咳/.test(visible.opening) && visible.diagnoses.find(item => /pneumonia/i.test(item.name));
  if (!diagnosis) return fauxAssistantMessage('This teaching script has insufficient evidence to complete the encounter.');
  if (!seen('diagnose')) return tool('diagnose', { codeSystem: diagnosis.codeSystem, code: diagnosis.code });
  const investigation = visible.services.find(item => /blood count/i.test(item.name));
  if (investigation && !seen('investigate')) return tool('investigate', { serviceCode: investigation.code });
  const drug = visible.drugs.find(item => item.name === 'Doxycycline');
  if (drug && !seen('prescribe')) return tool('prescribe', { codeSystem: drug.codeSystem, code: drug.code, dose: drug.dose, routeCode: drug.routeCode, timesPerDay: 2, days: 5, quantity: 10 });
  if (!seen('sign_record')) {
    const report = results.find(item => item.toolName === 'investigate')?.content.find(item => item.type === 'text')?.text;
    const note: Record<string, string> = { concern: visible.opening, subjective: results.find(item => item.toolName === 'ask_patient')?.content.find(item => item.type === 'text')?.text ?? visible.opening, objective: report ?? 'Clinical observations reviewed.', assessment: diagnosis.name, plan: drug ? `Review response to ${drug.name} and return if symptoms worsen.` : 'Review the clinical course.' };
    return tool('sign_record', { fields: visible.template.map(id => ({ id, text: note[id] ?? 'Reassess symptoms at follow-up.' })) });
  }
  if (!seen('complete')) return tool('complete', {});
  return fauxAssistantMessage('Encounter reviewed.');
};

export async function runEvaluationDoctor(store: StorePort, at: StoreScope, sessionId: string, config: AgentProvider, presentation: EvaluationPresentation, maxTurns: number, execute: (action: EvaluationAction) => Promise<unknown>, signal: AbortSignal) {
  const context = BACKGROUND_CONTEXT;
  let turns = 0;
  const model = clinicianModels(config, mockDoctor, signal, () => {}, async () => { if (signal.aborted) throw new CoreError(409, 'EVALUATION_STOPPED'); turns++; });
  const registry = createRegistry();
  registry.install({ name: 'evaluation', tools: Object.entries(tools).map(([name, schema]) => clinicianTool(name, descriptions[name as keyof typeof tools], schema, async args => execute({ name, args } as EvaluationAction), true)) });
  const harness = await openDurableAgentSession(store, at, sessionId, 'clinician', { models: model.models, registry, settings: { retry: { enabled: false }, compaction: { enabled: false } } });
  try {
    const doctor = await harness.root(context, { agent: { model: { provider: clinicianModel.provider, modelId: clinicianModel.id }, maxTurns, instructions: 'You are the tested clinician in an isolated synthetic Evaluation Run. Use the provided tools to ask the patient, choose actual investigations, confirm a diagnosis, decide medication, sign the complete record and finish the encounter. Use only visible facts, catalog entries and returned reports.' } });
    const submission = await doctor.submit({ type: 'input', content: JSON.stringify(presentation), requestId: sessionId }, context);
    const settled = await submission.wait(context);
    const usage = Object.values((await harness.usage(context)).models);
    return { turns, inputTokens: usage.reduce((sum, value) => sum + value.input, 0), outputTokens: usage.reduce((sum, value) => sum + value.output, 0), error: model.failure()?.code ?? (settled.status !== 'done' ? 'EVALUATION_INTERRUPTED' : null) };
  } finally { await harness.close(context); }
}
