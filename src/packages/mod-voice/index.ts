export { type BailianConnect, type BailianSocket, providerError } from './lib/bailian';
export { ParaformerTranscriber, type Transcriber } from './lib/transcriber';
export { SambertTTSProvider, type TTSProvider } from './lib/sambert';
export { openVoiceSession, voiceBinding, type VoiceSocket } from './lib/session';
export { voiceHandshake, voiceProtocols, voiceServerFrame } from './lib/protocol';
export const voiceModule = { id: 'mod-voice', kind: 'extension', version: '1' } as const;
