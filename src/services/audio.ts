class SoundEffects {
  private ctx: AudioContext | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private lastImpactTime = 0;

  private ensureContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    if (!this.noiseBuffer && this.ctx) {
      const sampleRate = this.ctx.sampleRate;
      const length = Math.floor(sampleRate * 0.14);
      const buffer = this.ctx.createBuffer(1, length, sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (sampleRate * 0.025));
      }
      this.noiseBuffer = buffer;
    }
    return this.ctx;
  }

  public unlock(): void {
    this.ensureContext();
  }

  public playThrowWhoosh(strength: number, muted: boolean): void {
    if (muted) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.noiseBuffer) return;

    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(240, now);
    filter.frequency.exponentialRampToValueAtTime(520, now + 0.11);
    filter.Q.value = 1.4;

    const gain = ctx.createGain();
    const vol = Math.min(0.12, 0.04 + strength * 0.05);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(now);
    src.stop(now + 0.14);
  }

  public playBounce(impactSpeed: number, muted: boolean): void {
    if (muted) return;
    const nowMs = performance.now();
    if (nowMs - this.lastImpactTime < 55) return;
    if (impactSpeed < 0.75) return;
    this.lastImpactTime = nowMs;

    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const intensity = Math.min(1, Math.max(0.08, (impactSpeed - 0.6) / 9.5));

    // Soft felt/wood low body thud
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const baseFreq = 105 + Math.random() * 22;
    osc.frequency.setValueAtTime(baseFreq, now);
    osc.frequency.exponentialRampToValueAtTime(42, now + 0.09);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(intensity * 0.24, now);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);

    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);

    // Subtle damped felt transient
    if (this.noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(480 + intensity * 420, now);

      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(intensity * 0.14, now);
      nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.065);

      noise.connect(filter);
      filter.connect(nGain);
      nGain.connect(ctx.destination);
      noise.start(now);
      noise.stop(now + 0.07);
    }
  }

  public playSettleClick(muted: boolean): void {
    if (muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;

    // Tactile bakelite/resin micro-click
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(680, now);
    osc.frequency.exponentialRampToValueAtTime(190, now + 0.032);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.11, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.04);
  }

  public playDartThrow(power: number, muted: boolean): void {
    if (muted) return;
    const ctx = this.ensureContext();
    if (!ctx || !this.noiseBuffer) return;

    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(520, now);
    filter.frequency.exponentialRampToValueAtTime(1450 + power * 420, now + 0.085);
    filter.Q.value = 1.6;

    const gain = ctx.createGain();
    const vol = Math.min(0.14, 0.045 + power * 0.06);
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(vol, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(now);
    src.stop(now + 0.1);
  }

  public playDartThunk(impactSpeed: number, muted: boolean): void {
    if (muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const intensity = Math.min(1, Math.max(0.45, impactSpeed / 14));

    // Punchy papier-mache / dense paper core "thunk"
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(175, now);
    osc.frequency.exponentialRampToValueAtTime(54, now + 0.085);

    const oscGain = ctx.createGain();
    oscGain.gain.setValueAtTime(0.32 * intensity, now);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.105);

    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.11);

    // Tight paper puncture transient
    if (this.noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;

      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.setValueAtTime(420, now);
      filter.Q.value = 1.1;

      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.22 * intensity, now);
      nGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);

      noise.connect(filter);
      filter.connect(nGain);
      nGain.connect(ctx.destination);
      noise.start(now);
      noise.stop(now + 0.05);
    }
  }

  public playDartMissFloor(muted: boolean): void {
    if (muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, now);
    osc.frequency.exponentialRampToValueAtTime(95, now + 0.045);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.07, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.055);
  }
}

export const soundEffects = new SoundEffects();
