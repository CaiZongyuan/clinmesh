import { z } from 'zod';
import { bailianTask, type BailianConnect } from './bailian';

export const voiceName = z.string().regex(/^sambert-[a-z0-9]{1,32}-v1$/);
export type SynthesisOptions = { voice?: string; signal?: AbortSignal };
export interface TTSProvider { synthesize(text: string, options?: SynthesisOptions | AbortSignal): Promise<ArrayBuffer> }

function finishedWav(chunks: ArrayBuffer[], length: number) {
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
  const view = new DataView(bytes.buffer);
  const invalid = () => Error('VOICE_INVALID_RESPONSE');
  if (length < 44 || view.getUint32(0) !== 0x52494646 || view.getUint32(8) !== 0x57415645) throw invalid();
  const riff = view.getUint32(4, true);
  if (riff !== 0x7fffffbf && riff !== length - 8) throw invalid();
  view.setUint32(4, length - 8, true);
  let hasFormat = false;
  for (let header = 12; header + 8 <= length;) {
    const tag = view.getUint32(header), size = view.getUint32(header + 4, true);
    if (tag === 0x64617461) {
      const remaining = length - header - 8;
      if (!hasFormat || !remaining || !size || (size !== 0x7fffff9b && size > remaining)) throw invalid();
      if (size === 0x7fffff9b) view.setUint32(header + 4, remaining, true);
      return bytes.buffer;
    }
    if (tag === 0x666d7420 && size >= 16) hasFormat = true;
    header += 8 + size + size % 2;
  }
  throw invalid();
}

export class SambertTTSProvider implements TTSProvider {
  constructor(private readonly token: string, private readonly connect: BailianConnect) {}
  async synthesize(text: string, options: SynthesisOptions | AbortSignal = {}) {
    const { signal, voice } = 'aborted' in options ? { signal: options, voice: undefined } : options;
    const model = voiceName.parse(voice ?? 'sambert-zhichu-v1');
    const input = z.string().trim().min(1).max(8000).parse(text);
    if (input.includes(this.token)) throw Error('VOICE_SECRET_IN_INPUT');
    const chunks: ArrayBuffer[] = [];
    let length = 0;
    const task = bailianTask(this.token, this.connect, 'out', { task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer', model, input: { text: input },
      parameters: { text_type: 'PlainText', format: 'wav', sample_rate: 16000 } }, signal, {
      started: () => task.deadline(60000),
      binary(frame) { length += frame.byteLength; if (length > 8 * 1024 * 1024) throw Error(); chunks.push(frame); },
    });
    await task.done;
    return finishedWav(chunks, length);
  }
}
