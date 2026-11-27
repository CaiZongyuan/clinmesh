import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it.each([16000, 44100, 48000])('encodes exactly 100 ms of %i Hz input as 3200 bytes of mono PCM16 LE', sampleRate => {
  let Processor!: new () => { process(input: Float32Array[][]): void; port: { onmessage(): void } };
  const frames: { pcm: ArrayBuffer; speech: boolean }[] = [];
  runInNewContext(readFileSync(new URL('./pcm.worklet.js', import.meta.url), 'utf8'), {
    sampleRate, AudioWorkletProcessor: class { port = { postMessage: (frame: { pcm: ArrayBuffer; speech: boolean }) => { if (frame.pcm) frames.push(frame); } }; },
    registerProcessor: (_name: string, registered: typeof Processor) => { Processor = registered; },
  });
  const processor = new Processor();
  const input = new Float32Array(sampleRate / 10).fill(-0.5); input.fill(1, sampleRate / 20);
  for (let offset = 0; offset < input.length; offset += 128) processor.process([[input.subarray(offset, offset + 128)]]);
  expect(frames).toHaveLength(1); expect(frames[0]!.speech).toBe(true);
  const pcm = new DataView(frames[0]!.pcm);
  expect([pcm.byteLength, pcm.getInt16(0, true), pcm.getInt16(3198, true)]).toEqual([3200, -16384, 32767]);
  processor.process([[new Float32Array(sampleRate / 100).fill(0)]]); processor.port.onmessage();
  expect(frames[1]!.pcm.byteLength).toBe(320); expect(frames[1]!.speech).toBe(false);
});
