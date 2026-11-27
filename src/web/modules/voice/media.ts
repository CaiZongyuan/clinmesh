import workletUrl from './pcm.worklet.js?url&no-inline';

export async function capturePcm(context: AudioContext, signal: AbortSignal, feed: (pcm: ArrayBuffer, speech: boolean) => void) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
  const stopTracks = () => stream.getTracks().forEach(track => track.stop());
  let node: AudioWorkletNode | undefined, source: MediaStreamAudioSourceNode | undefined;
  let drained: (() => void) | undefined;
  function close() { stopTracks(); source?.disconnect(); node?.disconnect(); node?.port.close(); drained?.(); }
  if (signal.aborted) { close(); signal.throwIfAborted(); }
  signal.addEventListener('abort', close, { once: true });
  try {
    await context.audioWorklet.addModule(workletUrl);
    signal.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'consultation-pcm', { channelCount: 1, channelCountMode: 'explicit', numberOfOutputs: 0 });
    node.port.onmessage = event => {
      if (signal.aborted) return;
      if (event.data === 'finished') { drained?.(); return; }
      feed(event.data.pcm, event.data.speech);
    };
    source.connect(node);
    return async () => {
      stopTracks();
      try { await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 300);
        drained = () => { clearTimeout(timeout); resolve(); };
        node!.port.postMessage('finish');
      }); } finally { close(); signal.removeEventListener('abort', close); }
    };
  } catch (error) { close(); signal.removeEventListener('abort', close); throw error; }
}
