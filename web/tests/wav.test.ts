import { describe, expect, it } from 'vitest'
import { downsample, encodeWav } from '../src/lib/wav.ts'

const readAscii = (view: DataView, offset: number, length: number) =>
  Array.from({ length }, (_, index) => String.fromCharCode(view.getUint8(offset + index))).join('')

describe('encodeWav', () => {
  it('writes a RIFF/WAVE header whisper.cpp can read: 16-bit mono at the given rate', () => {
    const view = new DataView(encodeWav(new Float32Array([0, 0.5, -0.5]), 16000))
    expect(readAscii(view, 0, 4)).toBe('RIFF')
    expect(readAscii(view, 8, 4)).toBe('WAVE')
    expect(view.getUint16(20, true)).toBe(1)       // PCM
    expect(view.getUint16(22, true)).toBe(1)       // mono
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(34, true)).toBe(16)      // bits
    expect(view.getUint32(40, true)).toBe(6)       // 3 samples * 2 bytes
  })

  it('clamps out-of-range samples instead of wrapping them into noise', () => {
    const view = new DataView(encodeWav(new Float32Array([2, -2]), 16000))
    expect(view.getInt16(44, true)).toBe(32767)
    expect(view.getInt16(46, true)).toBe(-32768)
  })
})

describe('downsample', () => {
  it('averages down to the target rate', () => {
    expect(Array.from(downsample(new Float32Array([0, 1, 0, 1]), 32000, 16000))).toEqual([0.5, 0.5])
  })
  it('leaves audio alone when it is already at or below the target', () => {
    const samples = new Float32Array([0.1, 0.2])
    expect(downsample(samples, 16000, 16000)).toBe(samples)
  })
})
