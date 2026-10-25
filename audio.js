export class GameMixer {
  constructor(memory, sounds, stride) {
    this.memory = memory;
    this.sounds = sounds;
    this.stride = stride;
    this.voices = [];
  }

  mix(left, right, sampleRate) {
    left.fill(0);
    right.fill(0);
    const buffer = this.memory.buffer;
    if (this.buffer !== buffer) {
      this.buffer = buffer;
      this.u8 = new Uint8Array(buffer);
      this.i16 = new Int16Array(buffer);
      this.u32 = new Uint32Array(buffer);
    }
    const { u8, i16, u32 } = this;
    for (let index = 0; index < 256; index++) {
      const word = (this.sounds >>> 2) + index * this.stride;
      const pcm = u32[word];
      if (!pcm) {
        this.voices[index] = undefined;
        continue;
      }
      const generation = u32[word + 11];
      let voice = this.voices[index];
      if (!voice || voice.generation !== generation) {
        voice = this.voices[index] = { generation, seek: -1, position: 0, playing: false };
      }
      const channels = u32[word + 2];
      const bits = u32[word + 3];
      const align = channels * bits / 8;
      const frames = u32[word + 1] / align;
      if (!frames || ![1, 2].includes(channels) || ![8, 16].includes(bits)) continue;
      const count = Math.min(u32[word + 12], 128);
      const notes = word + 13;
      const seek = u32[word + 9];
      if (seek !== voice.seek) {
        voice.seek = seek;
        voice.position = u32[word + 10] / align;
      }
      const status = u32[word + 8];
      const signal = note => {
        const flag = u32[notes + 2 * note + 1];
        if (flag) u32[flag >>> 2] = 1;
      };
      if (!(status & 1)) {
        if (voice.playing) {
          for (let note = 0; note < count; note++) if (u32[notes + 2 * note] === 0xffffffff) signal(note);
        }
        voice.playing = false;
        continue;
      }
      voice.playing = true;
      const loop = !!(status & 4);
      const volume = u32[word + 5] | 0;
      const pan = u32[word + 6] | 0;
      const step = u32[word + 4] / sampleRate;
      const gain = volume === -10000 ? 0 : 10 ** (volume / 2000);
      const leftGain = gain * 10 ** (-Math.max(0, pan) / 2000);
      const rightGain = gain * 10 ** (Math.min(0, pan) / 2000);
      const sample = bits === 8
        ? (frame, channel) => (u8[pcm + frame * channels + channel] - 128) / 128
        : (frame, channel) => i16[(pcm >>> 1) + frame * channels + channel] / 32768;
      const rightChannel = channels === 2 ? 1 : 0;
      for (let frame = 0; frame < left.length; frame++) {
        if (voice.position >= frames) {
          if (loop) voice.position %= frames;
          else {
            voice.playing = false;
            voice.position = 0;
            break;
          }
        }
        const at = Math.floor(voice.position);
        const next = at + 1 < frames ? at + 1 : loop ? 0 : at;
        const fraction = voice.position - at;
        left[frame] += (sample(at, 0) * (1 - fraction) + sample(next, 0) * fraction) * leftGain;
        right[frame] += (sample(at, rightChannel) * (1 - fraction) + sample(next, rightChannel) * fraction) * rightGain;
        const end = voice.position + step;
        for (let note = 0; note < count; note++) {
          const offset = u32[notes + 2 * note];
          if (offset === 0xffffffff) {
            if (!loop && end >= frames) signal(note);
          } else {
            const position = offset / align;
            if ((position >= voice.position && position < end) || (loop && end >= frames && position < end % frames)) signal(note);
          }
        }
        voice.position = loop ? end % frames : end;
        if (!loop && voice.position >= frames) {
          voice.playing = false;
          voice.position = 0;
          break;
        }
      }
      if (!voice.playing) u32[word + 8] = 0;
      if (u32[word + 9] === voice.seek) u32[word + 7] = Math.floor(voice.position) * align;
    }
  }
}

export function createGameAudio(module, memory, sounds, stride) {
  if (module.peAudio) return 1;
  if (!globalThis.AudioContext) return 0;
  const context = new AudioContext();
  const gain = context.createGain();
  gain.connect(context.destination);
  const mixer = new GameMixer(memory, sounds, stride);
  const audio = module.peAudio = { context, gain, mixer, ready: Promise.resolve(), queued: new Set(), frames: 0, maxPeak: 0 };
  let next = 0;
  let timer;
  const stop = () => {
    clearInterval(timer);
    for (const source of audio.queued) source.stop();
    audio.queued.clear();
    context.close().catch(() => {});
  };
  const pump = () => {
    if (module.peProcessStopped || module.peWorkerError || context.state === 'closed') {
      stop();
      return;
    }
    if (context.state !== 'running') return;
    next = Math.max(next, context.currentTime + 0.008);
    while (next < context.currentTime + 0.08) {
      const buffer = context.createBuffer(2, 2048, context.sampleRate);
      mixer.mix(buffer.getChannelData(0), buffer.getChannelData(1), context.sampleRate);
      audio.frames += buffer.length;
      for (let frame = 0; frame < buffer.length; frame++) {
        audio.maxPeak = Math.max(audio.maxPeak, Math.abs(buffer.getChannelData(0)[frame]), Math.abs(buffer.getChannelData(1)[frame]));
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = () => {
        audio.queued.delete(source);
        source.disconnect();
      };
      audio.queued.add(source);
      source.start(next);
      next += buffer.duration;
    }
  };
  timer = setInterval(pump, 20);
  const abort = module.onAbort;
  module.onAbort = reason => {
    stop();
    abort?.(reason);
  };
  context.resume().catch(() => {});
  return 1;
}
