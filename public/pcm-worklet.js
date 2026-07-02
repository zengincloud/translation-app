// Captures raw mic audio and downsamples it to 16kHz 16-bit PCM (what xAI's streaming STT
// requires) inside the audio render thread, so chunks can be streamed out continuously while
// the talk button is held instead of waiting for the whole recording to finish.
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 16000;
    this.ratio = sampleRate / this.targetSampleRate; // `sampleRate` is a global in worklet scope
    this.acc = 0;
  }

  process(inputs) {
    const channelData = inputs[0] && inputs[0][0];
    if (!channelData) return true;

    const outSamples = [];
    for (let i = 0; i < channelData.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        outSamples.push(channelData[i]);
      }
    }

    if (outSamples.length > 0) {
      const pcm16 = new Int16Array(outSamples.length);
      for (let i = 0; i < outSamples.length; i++) {
        const s = Math.max(-1, Math.min(1, outSamples[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-capture-processor', PCMCaptureProcessor);
