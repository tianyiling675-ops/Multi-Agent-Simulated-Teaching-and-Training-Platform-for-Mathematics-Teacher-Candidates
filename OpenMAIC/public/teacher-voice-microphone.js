/* global AudioWorkletProcessor, registerProcessor, sampleRate */

class TeacherVoiceMicrophone extends AudioWorkletProcessor {
  frame = new Int16Array(320);
  index = 0;
  sum = 0;
  weight = 0;

  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    const ratio = sampleRate / 16_000;
    for (const sample of samples) {
      let remaining = 1;
      while (remaining > 0) {
        const weight = Math.min(remaining, ratio - this.weight);
        this.sum += sample * weight;
        this.weight += weight;
        remaining -= weight;
        if (this.weight >= ratio - 1e-9) {
          const value = Math.max(-1, Math.min(1, this.sum / ratio));
          this.frame[this.index++] = value * (value < 0 ? 32_768 : 32_767);
          this.sum = 0;
          this.weight = 0;
        }
        if (this.index === this.frame.length) {
          this.port.postMessage(this.frame.buffer, [this.frame.buffer]);
          this.frame = new Int16Array(320);
          this.index = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('teacher-voice-microphone', TeacherVoiceMicrophone);
