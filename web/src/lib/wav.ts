/**
 * Encodes mono PCM as a 16-bit WAV. Recording straight to the format whisper wants removes the
 * transcode step: macOS afconvert cannot read the webm/opus that MediaRecorder produces.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)          // PCM chunk size
  view.setUint16(20, 1, true)           // format: PCM
  view.setUint16(22, 1, true)           // channels: mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)           // block align
  view.setUint16(34, 16, true)          // bits per sample
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return buffer
}

/** Averages neighbouring samples down to the target rate. Whisper wants 16 kHz. */
export function downsample(samples: Float32Array, from: number, to: number): Float32Array {
  if (to >= from) return samples
  const ratio = from / to
  const out = new Float32Array(Math.floor(samples.length / ratio))
  for (let index = 0; index < out.length; index += 1) {
    const start = Math.floor(index * ratio)
    const end = Math.min(Math.floor((index + 1) * ratio), samples.length)
    let total = 0
    for (let cursor = start; cursor < end; cursor += 1) total += samples[cursor]
    // `to < from` is guaranteed above and out.length is floor(len/ratio), so the window is never empty.
    out[index] = total / (end - start)
  }
  return out
}
