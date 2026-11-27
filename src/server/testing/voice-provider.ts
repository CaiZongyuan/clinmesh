import { z } from 'zod';

export const hostKey = 'synthetic-voice-host', visitorKey = 'synthetic-voice-visitor';
export function scriptedBailian(authorization: string | undefined, send: (data: string | ArrayBuffer) => void) {
  let id = '';
  const event = (event: string, payload = {}) => send(JSON.stringify({ header: { event, task_id: id }, payload }));
  return (frame: string | ArrayBuffer) => {
    if (typeof frame !== 'string') {
      if (frame.byteLength !== 3200 || new DataView(frame).getInt16(0, true) !== -1600) throw Error('Unexpected PCM');
      event('result-generated', { output: { sentence: { sentence_end: false, text: 'A teaching' } } });
      event('result-generated', { output: { sentence: { sentence_end: true, text: 'A teaching question.' } } });
      return;
    }
    const { header, payload } = z.object({ header: z.object({ action: z.string(), task_id: z.string() }), payload: z.object({ task: z.string().optional() }) }).parse(JSON.parse(frame));
    id = header.task_id;
    if (header.action === 'finish-task') { event('task-finished'); return; }
    if (authorization !== `Bearer ${payload.task === 'tts' ? hostKey : visitorKey}`) {
      send(JSON.stringify({ header: { task_id: id, event: 'task-failed', error_code: 'InvalidApiKey', error_message: `private: ${authorization}` } })); return;
    }
    event('task-started');
    if (payload.task === 'tts') {
      const hex = '52494646bfffff7f57415645666d74201000000001000100803e0000007d000002001000646174619bffff7f80ff';
      send(Uint8Array.from(hex.match(/../g)!, byte => parseInt(byte, 16)).buffer);
      event('task-finished');
    }
  };
}
