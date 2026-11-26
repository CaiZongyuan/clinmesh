---
status: accepted
---

# Modular Voice Pipeline with Alibaba Cloud Bailian Default and BYOK Portability

Voice interaction lives in an opt-in **Clinical Module** (`mod-voice`) behind clean `Transcriber` and `TTSProvider` ports—wired to Cloudflare `agents/voice` WebSocket sessions on Workers and an isomorphic WebSocket route on Node. Phase 1 ships Alibaba Cloud Bailian adapters sharing a single `BAILIAN_TOKEN` (`paraformer-realtime-v2` 16 kHz PCM duplex streaming STT supporting `["zh", "en"]` under 36K s/month free quota, and `sambert` streaming TTS with WAV sentinel header repair and `AbortSignal` barge-in cancellation), paired with an explicit zero-key browser Web Speech API fallback and browser BYOK credential pass-through so global providers (such as OpenAI or ElevenLabs) plug in without domain changes. The UI enforces two isolated voice channels: the clinic Consultation Mic (transcribing clinician speech to **Patient Agent** with interruptible patient TTS playback) and a separate Assistant Push-to-Talk control inside the **Clinician Assistant** panel.

## Considered Options

- **Cloudflare Workers AI default TTS + STT**: Built-in Aura TTS lacks Chinese quality parity and couples local development to Cloudflare account bindings.
- **Browser Web Speech API only**: Zero cost, but transcription accuracy and TTS voice quality vary heavily across browsers and operating systems.

## Consequences

- `SambertTTSProvider` repairs streamed WAV sentinel lengths (`0x7fffffbf` / `0x7fffff9b`) on `task-finished` and never sends `finish-task`; `ParaformerTranscriber` buffers frames until `task-started`.
- Every **Consultation** turn preserves a `speaker` attribution field so future real-clinic ambient multi-speaker diarization requires no clinical schema break.
- User-supplied BYOK voice tokens pass per-session over WSS/HTTPS and are never stored in shared server databases.
