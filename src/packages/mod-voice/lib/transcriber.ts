import { z } from 'zod';
import { bailianTask, type BailianConnect } from './bailian';

type SessionOptions = { signal?: AbortSignal; language?: string; onPartial?(text: string): void; onFinal?(text: string): void;
  onInterim?(text: string): void; onSpeechStart?(text?: string): void; onUtterance?(text: string): void; onFatalError?(error: Error): void };
export interface Transcriber { createSession(options?: SessionOptions): { feed(chunk: ArrayBuffer): void; close(): Promise<void> } }
const result = z.object({ output: z.object({ sentence: z.union([z.object({ heartbeat: z.literal(true) }), z.object({ sentence_end: z.boolean(), text: z.string().max(8000) })]) }) });

export class ParaformerTranscriber implements Transcriber {
  constructor(private readonly token: string, private readonly connect: BailianConnect) {}
  createSession(options: SessionOptions = {}) {
    const token = this.token;
    let started = false, closing = false, speaking = false, queuedBytes = 0;
    const queued: ArrayBuffer[] = [];
    const task = bailianTask(this.token, this.connect, 'duplex', { task_group: 'audio', task: 'asr', function: 'recognition', model: 'paraformer-realtime-v2', input: {}, parameters: {
      format: 'pcm', sample_rate: 16000, language_hints: ['zh', 'en'], semantic_punctuation_enabled: true,
    } }, options.signal, {
      started() {
        started = true;
        for (const frame of queued) task.send(frame);
        queued.length = 0;
        if (closing) finish();
      },
      result(payload) {
        const { sentence } = result.parse(payload).output;
        if ('heartbeat' in sentence || !sentence.text.trim()) return;
        if (sentence.text.includes(token)) throw Error();
        if (!speaking) options.onSpeechStart?.(sentence.text);
        speaking = !sentence.sentence_end;
        if (speaking) (options.onPartial ?? options.onInterim)?.(sentence.text);
        else (options.onFinal ?? options.onUtterance)?.(sentence.text);
      },
      finished() { if (!closing) throw Error(); },
    });
    function finish() { task.deadline(5000); task.finish(); }
    void task.done.catch(error => { if (!options.signal?.aborted) options.onFatalError?.(error); }).finally(() => { queued.length = 0; closing = true; });
    return {
      feed(chunk: ArrayBuffer) {
        if (closing || !chunk.byteLength) return;
        if (chunk.byteLength % 2 || chunk.byteLength > 32000) { task.end(Error('VOICE_INVALID_PCM')); return; }
        if (started) task.send(chunk);
        else if ((queuedBytes += chunk.byteLength) <= 320000) queued.push(chunk.slice(0));
        else task.end(Error('VOICE_AUDIO_BACKLOG'));
      },
      close() { if (!closing) { closing = true; if (started) finish(); } return task.done; },
    };
  }
}
