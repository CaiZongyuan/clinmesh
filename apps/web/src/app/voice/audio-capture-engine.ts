import { VOICE_SAMPLE_RATE } from '@clinmesh/contracts/voice'

const WORKLET_PROCESSOR_NAME = 'clinmesh-pcm16-capture'
const WORKLET_CHUNK_SAMPLES = 1_600 // ~100ms at 16 kHz

/**
 * Downsamples mono Float32 PCM samples from `sourceSampleRate` to `targetSampleRate` (16 kHz),
 * returning signed 16-bit LE PCM samples and normalized RMS audio level (0..1).
 */
export function downsampleToPcm16(
  input: Float32Array,
  sourceSampleRate: number,
  targetSampleRate = VOICE_SAMPLE_RATE,
): { pcm: Int16Array; rms: number } {
  if (input.length === 0) {
    return { pcm: new Int16Array(0), rms: 0 }
  }

  let sumSq = 0
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i] ?? 0
    sumSq += sample * sample
  }
  const rms = Math.min(1, Math.sqrt(sumSq / input.length) * 3.5)

  if (sourceSampleRate <= targetSampleRate) {
    const pcm = new Int16Array(input.length)
    for (let i = 0; i < input.length; i += 1) {
      const clamped = Math.max(-1, Math.min(1, input[i] ?? 0))
      pcm[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
    }
    return { pcm, rms }
  }

  const ratio = sourceSampleRate / targetSampleRate
  const outputLength = Math.max(1, Math.floor(input.length / ratio))
  const pcm = new Int16Array(outputLength)

  for (let outIndex = 0; outIndex < outputLength; outIndex += 1) {
    const start = Math.floor(outIndex * ratio)
    const end = Math.min(input.length, Math.floor((outIndex + 1) * ratio))
    let accum = 0
    let count = 0
    for (let j = start; j < end; j += 1) {
      accum += input[j] ?? 0
      count += 1
    }
    const averaged = count > 0 ? accum / count : 0
    const clamped = Math.max(-1, Math.min(1, averaged))
    pcm[outIndex] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff)
  }

  return { pcm, rms }
}

function buildWorkletModuleSource(): string {
  return `
class ClinMeshPcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = new Int16Array(${WORKLET_CHUNK_SAMPLES});
    this._filled = 0;
    this._ratio = sampleRate / ${VOICE_SAMPLE_RATE};
    this._phase = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;
    const channel = input[0];
    let sumSq = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const s = channel[i];
      sumSq += s * s;
    }
    const rms = Math.min(1, Math.sqrt(sumSq / channel.length) * 3.5);

    if (this._ratio <= 1.001) {
      for (let i = 0; i < channel.length; i += 1) {
        const clamped = Math.max(-1, Math.min(1, channel[i]));
        this._buffer[this._filled++] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
        if (this._filled >= ${WORKLET_CHUNK_SAMPLES}) {
          const out = this._buffer.slice(0, this._filled);
          this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
          this._filled = 0;
        }
      }
      return true;
    }

    let pos = this._phase;
    while (pos < channel.length) {
      const idx = Math.floor(pos);
      const next = Math.min(channel.length - 1, idx + 1);
      const frac = pos - idx;
      const sample = channel[idx] * (1 - frac) + channel[next] * frac;
      const clamped = Math.max(-1, Math.min(1, sample));
      this._buffer[this._filled++] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
      if (this._filled >= ${WORKLET_CHUNK_SAMPLES}) {
        const out = this._buffer.slice(0, this._filled);
        this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
        this._filled = 0;
      }
      pos += this._ratio;
    }
    this._phase = pos - channel.length;
    return true;
  }
}
registerProcessor('${WORKLET_PROCESSOR_NAME}', ClinMeshPcm16CaptureProcessor);
`
}

export interface Pcm16CaptureHandle {
  stop: () => void
}

export interface StartPcm16CaptureOptions {
  deviceId?: string | undefined
  onChunk: (pcm16: ArrayBuffer, rms: number) => void
}

/**
 * Captures mono 16 kHz PCM16 microphone audio using modern AudioWorklet (off main thread),
 * falling back to ScriptProcessorNode only when AudioWorklet is unavailable.
 * Always stops all MediaStream tracks immediately when `stop()` is called.
 */
export async function startPcm16Capture(
  options: StartPcm16CaptureOptions,
): Promise<Pcm16CaptureHandle> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持麦克风采集（需要安全上下文或 HTTPS/localhost）。')
  }

  const audioConstraints: MediaTrackConstraints = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(options.deviceId && options.deviceId.trim().length > 0
      ? { deviceId: { exact: options.deviceId.trim() } }
      : {}),
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints })
  const AudioContextCtor = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) {
    for (const track of stream.getTracks()) track.stop()
    throw new Error('当前浏览器不支持 Web Audio API。')
  }

  const context = new AudioContextCtor({ sampleRate: VOICE_SAMPLE_RATE })
  if (context.state === 'suspended') {
    await context.resume().catch(() => undefined)
  }
  const source = context.createMediaStreamSource(stream)
  // Silent sink keeps the audio graph pulling without outputting microphone audio to speakers.
  const silentGain = context.createGain()
  silentGain.gain.value = 0
  silentGain.connect(context.destination)

  let stopped = false
  let workletUrl: string | null = null
  let workletNode: AudioWorkletNode | null = null
  let fallbackProcessor: ScriptProcessorNode | null = null

  const stop = () => {
    if (stopped) return
    stopped = true
    if (workletNode !== null) {
      workletNode.port.onmessage = null
      try { workletNode.disconnect() } catch { /* ignore */ }
      workletNode = null
    }
    if (fallbackProcessor !== null) {
      fallbackProcessor.onaudioprocess = null
      try { fallbackProcessor.disconnect() } catch { /* ignore */ }
      fallbackProcessor = null
    }
    try { source.disconnect() } catch { /* ignore */ }
    try { silentGain.disconnect() } catch { /* ignore */ }
    for (const track of stream.getTracks()) {
      try { track.stop() } catch { /* ignore */ }
    }
    if (workletUrl !== null) {
      URL.revokeObjectURL(workletUrl)
      workletUrl = null
    }
    void context.close().catch(() => undefined)
  }

  try {
    if (typeof AudioWorkletNode !== 'undefined' && context.audioWorklet && typeof URL.createObjectURL === 'function') {
      const blob = new Blob([buildWorkletModuleSource()], { type: 'application/javascript' })
      workletUrl = URL.createObjectURL(blob)
      await context.audioWorklet.addModule(workletUrl)
      if (stopped) return { stop }
      workletNode = new AudioWorkletNode(context, WORKLET_PROCESSOR_NAME)
      workletNode.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
        if (stopped) return
        if (event.data && event.data.pcm instanceof ArrayBuffer) {
          options.onChunk(event.data.pcm, typeof event.data.rms === 'number' ? event.data.rms : 0)
        }
      }
      source.connect(workletNode)
      workletNode.connect(silentGain)
      return { stop }
    }
  } catch {
    if (workletUrl !== null) {
      URL.revokeObjectURL(workletUrl)
      workletUrl = null
    }
    // Fall through cleanly to ScriptProcessorNode fallback.
  }

  if (typeof context.createScriptProcessor === 'function') {
    fallbackProcessor = context.createScriptProcessor(2048, 1, 1)
    fallbackProcessor.onaudioprocess = (event) => {
      if (stopped) return
      const inputData = event.inputBuffer.getChannelData(0)
      const { pcm, rms } = downsampleToPcm16(inputData, context.sampleRate, VOICE_SAMPLE_RATE)
      if (pcm.byteLength > 0) {
        const buffer = new ArrayBuffer(pcm.byteLength)
        new Int16Array(buffer).set(pcm)
        options.onChunk(buffer, rms)
      }
    }
    source.connect(fallbackProcessor)
    fallbackProcessor.connect(silentGain)
    return { stop }
  }

  stop()
  throw new Error('当前浏览器无法初始化音频采集处理器。')
}
