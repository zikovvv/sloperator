import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { downsample, encodeWav } from './wav.ts'
import { quiet } from './quiet.ts'

type VoiceState = 'idle' | 'recording' | 'transcribing' | 'unavailable'
const TARGET_RATE = 16000

/**
 * Dictation, entirely on this machine. Audio is captured as raw PCM and encoded as a 16 kHz mono
 * WAV in the browser, which is exactly what whisper.cpp reads — no transcode, nothing uploaded.
 */
export function useVoice(onText: (text: string) => void) {
  const [state, setState] = useState<VoiceState>('idle')
  const [hint, setHint] = useState<string | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const chunksRef = useRef<Float32Array[]>([])
  const rateRef = useRef(TARGET_RATE)

  useEffect(() => {
    void api.voiceStatus()
      .then((status) => {
        if (!status.available) { setState('unavailable'); setHint(status.hint ?? null) }
      })
      .catch(() => { setState('unavailable'); setHint('Could not reach the server.') })
  }, [])

  const teardown = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    void contextRef.current?.close().catch(quiet)
    contextRef.current = null
  }, [])

  const stop = useCallback(async () => {
    if (state !== 'recording') return
    const rate = rateRef.current
    teardown()

    const total = chunksRef.current.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new Float32Array(total)
    let offset = 0
    for (const chunk of chunksRef.current) { merged.set(chunk, offset); offset += chunk.length }
    chunksRef.current = []

    if (total < rate / 4) { setState('idle'); setHint('Too short — hold the button while you speak.'); return }

    setState('transcribing')
    try {
      const wav = encodeWav(downsample(merged, rate, TARGET_RATE), TARGET_RATE)
      const text = await api.transcribe(new Blob([wav], { type: 'audio/wav' }))
      if (text.trim()) onText(text.trim())
      else setHint('Nothing was recognised.')
      setState('idle')
    } catch (error) {
      setState('idle')
      setHint((error as Error).message)
    }
  }, [state, teardown, onText])

  const start = useCallback(async () => {
    setHint(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const context = new AudioContext({ sampleRate: TARGET_RATE })
      contextRef.current = context
      rateRef.current = context.sampleRate
      const source = context.createMediaStreamSource(stream)
      const processor = context.createScriptProcessor(4096, 1, 1)
      chunksRef.current = []
      processor.onaudioprocess = (event) => {
        chunksRef.current.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      processor.connect(context.destination)
      setState('recording')
    } catch (error) {
      setState('idle')
      setHint((error as Error).name === 'NotAllowedError'
        ? 'Microphone access was denied.' : (error as Error).message)
    }
  }, [])

  const toggle = useCallback(() => {
    if (state === 'recording') void stop()
    else if (state === 'idle') void start()
  }, [state, start, stop])

  useEffect(() => teardown, [teardown])

  return { state, hint, toggle, stop }
}
