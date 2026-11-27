import type { ReplyProgress } from '../../agent-protocol';

export class LiveProgress {
  private readonly history: { ordinal: number; event: ReplyProgress }[] = [];
  private readonly subscribers = new Set<() => void>();
  private closed = false;

  publish(event: ReplyProgress) {
    const ordinal = event.pass * 1000 + (event.phase === 'checking' ? 999 : event.chunks);
    if (this.closed || ordinal <= (this.history.at(-1)?.ordinal ?? 0)) return;
    this.history.push({ ordinal, event });
    for (const notify of this.subscribers) notify();
  }

  close() {
    this.closed = true;
    for (const notify of this.subscribers) notify();
  }

  async *after(cursor: number, signal: AbortSignal) {
    while (!signal.aborted) {
      const next = this.history.find(update => update.ordinal > cursor);
      if (next) { cursor = next.ordinal; yield next; continue; }
      if (this.closed) return;
      await new Promise<void>(resolve => {
        const notify = () => { this.subscribers.delete(notify); signal.removeEventListener('abort', notify); resolve(); };
        this.subscribers.add(notify);
        signal.addEventListener('abort', notify, { once: true });
      });
    }
  }
}
