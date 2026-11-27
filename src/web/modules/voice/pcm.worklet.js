class ConsultationPcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new DataView(new ArrayBuffer(3200));
    this.samples = 0;
    this.energy = 0;
    this.weight = 0;
    this.sum = 0;
    this.closed = false;
    this.port.onmessage = () => { this.closed = true; this.flush(); this.port.postMessage('finished'); };
  }
  flush() {
    if (!this.samples) return;
    const pcm = this.samples === 1600 ? this.frame.buffer : this.frame.buffer.slice(0, this.samples * 2);
    this.port.postMessage({ pcm, speech: this.energy / this.samples > 0.0009 }, [pcm]);
    this.frame = new DataView(new ArrayBuffer(3200));
    this.samples = 0;
    this.energy = 0;
  }
  process(inputs) {
    if (this.closed) return false;
    for (const value of inputs[0]?.[0] ?? []) {
      let duration = 16000;
      while (duration > 0) {
        const portion = Math.min(duration, sampleRate - this.weight);
        this.sum += portion * value;
        this.weight += portion;
        duration -= portion;
        if (this.weight < sampleRate) continue;
        const sample = Math.max(-1, Math.min(1, this.sum / sampleRate));
        this.frame.setInt16(this.samples++ * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
        this.energy += sample * sample;
        this.weight = 0;
        this.sum = 0;
        if (this.samples === 1600) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('consultation-pcm', ConsultationPcm);
