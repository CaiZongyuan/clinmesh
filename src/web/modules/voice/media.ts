import workletUrl from './pcm.worklet.js?url&no-inline';

export function capturePcm(context: AudioContext, signal: AbortSignal, feed: (pcm: ArrayBuffer, speech: boolean) => void) {
  let stream: MediaStream | undefined, node: AudioWorkletNode | undefined, source: MediaStreamAudioSourceNode | undefined;
  let closed = false, drained: (() => void) | undefined;
  function stopInput() { stream?.getTracks().forEach(track => track.stop()); stream = undefined; source?.disconnect(); source = undefined; }
  function close() {
    if (closed) return;
    closed = true; stopInput(); node?.disconnect(); node?.port.close(); drained?.();
    signal.removeEventListener('abort', close);
  }
  signal.addEventListener('abort', close, { once: true });
  const device = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false }).then(media => {
    stream = media; if (closed) stopInput();
  });
  const ready = Promise.all([device, context.audioWorklet.addModule(workletUrl)]).then(() => {
    if (closed || !stream) return;
    source = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'consultation-pcm', { channelCount: 1, channelCountMode: 'explicit', numberOfOutputs: 0 });
    node.port.onmessage = event => {
      if (closed) return;
      if (event.data === 'finished') { close(); return; }
      feed(event.data.pcm, event.data.speech);
    };
    source.connect(node);
  });
  return { ready, finish() {
    stopInput();
    if (!node) { close(); return Promise.reject(Error('VOICE_MIC_NOT_READY')); }
    return new Promise<void>(resolve => {
      const timeout = setTimeout(close, 300);
      drained = () => { clearTimeout(timeout); resolve(); };
      node!.port.postMessage('finish');
    });
  } };
}
