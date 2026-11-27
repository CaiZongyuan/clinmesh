type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
interface Recognition {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onspeechstart: (() => void) | null; onend: (() => void) | null; onerror: ((event: { error: string }) => void) | null;
  start(): void; stop(): void; abort(): void;
}
export type MicEvents = { speech(): void; partial(text: string): void; final(text: string): void; end(error?: Error): void };
export function browserMic(lang: string, events: MicEvents, signal: AbortSignal) {
  const host: Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition } = window;
  const Constructor = host.SpeechRecognition ?? host.webkitSpeechRecognition;
  if (!Constructor) throw Error('VOICE_BROWSER_STT_UNAVAILABLE');
  const recognition = new Constructor();
  recognition.continuous = true; recognition.interimResults = true; recognition.lang = lang;
  recognition.onspeechstart = events.speech;
  recognition.onresult = event => {
    if (signal.aborted) return;
    let preview = '';
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const result = event.results[index]!;
      const text = result[0].transcript.trim();
      if (result.isFinal) { if (text) events.final(text); } else preview += text;
    }
    events.partial(preview);
  };
  const cancel = () => { recognition.onend = recognition.onerror = recognition.onspeechstart = recognition.onresult = null; recognition.abort(); };
  recognition.onerror = event => events.end(Error(event.error === 'not-allowed' || event.error === 'audio-capture' ? 'VOICE_MIC_UNAVAILABLE' : 'VOICE_BROWSER_STT_FAILED'));
  recognition.onend = () => { signal.removeEventListener('abort', cancel); events.end(); };
  signal.addEventListener('abort', cancel, { once: true });
  recognition.start();
  return () => recognition.stop();
}

export function browserSpeak(text: string, lang: string, signal: AbortSignal) {
  if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) throw Error('VOICE_BROWSER_TTS_UNAVAILABLE');
  return new Promise<void>((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    const cancel = () => { utterance.onend = utterance.onerror = null; speechSynthesis.cancel(); resolve(); };
    utterance.onend = () => { signal.removeEventListener('abort', cancel); resolve(); };
    utterance.onerror = () => { signal.removeEventListener('abort', cancel); reject(Error('VOICE_PLAYBACK_FAILED')); };
    signal.addEventListener('abort', cancel, { once: true });
    speechSynthesis.speak(utterance);
  });
}
