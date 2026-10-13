import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { agentEnv } from './engines.ts'

const run = promisify(execFile)

function whichWhisper(): string | null {
  // Tests pin a folder of fake binaries; otherwise the agent's PATH is searched.
  const directories = process.env.ORCHESTRATOR_BIN_DIR ? [process.env.ORCHESTRATOR_BIN_DIR] : String(agentEnv().PATH).split(':')
  for (const candidate of ['whisper-cli', 'whisper-cpp', 'whisper']) {
    for (const directory of directories) {
      const path = join(directory, candidate)
      if (existsSync(path)) return path
    }
  }
  return null
}

function modelPath(): string | null {
  const candidates = process.env.ORCHESTRATOR_WHISPER_MODEL ? [process.env.ORCHESTRATOR_WHISPER_MODEL] : [
    join(homedir(), '.cache/whisper/ggml-base.en.bin'),
    '/opt/homebrew/share/whisper-cpp/ggml-base.en.bin',
    join(homedir(), 'Library/Application Support/whisper/ggml-base.en.bin'),
  ]
  return candidates.find((path) => existsSync(path)) ?? null
}

export function voiceStatus() {
  const binary = whichWhisper()
  const model = modelPath()
  const hint = !binary
    ? 'Install a local transcriber: brew install whisper-cpp'
    : !model ? 'Download a model to ~/.cache/whisper/ggml-base.en.bin' : null
  return { available: hint === null, binary, model, hint }
}

/**
 * Transcribes a recorded clip entirely on this machine — nothing is uploaded. The browser sends
 * a 16 kHz mono WAV, which whisper.cpp reads directly: macOS has no decoder for the webm/opus
 * that MediaRecorder produces, so recording in the target format removes the conversion instead
 * of adding a second converter.
 */
export async function transcribe(audio: Buffer): Promise<string> {
  const status = voiceStatus()
  if (status.hint) throw new Error(status.hint)
  if (audio.length < 45 || audio.toString('ascii', 0, 4) !== 'RIFF'
      || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Expected a WAV recording.')
  }

  const workDirectory = join(tmpdir(), `orch-voice-${crypto.randomUUID()}`)
  mkdirSync(workDirectory, { recursive: true })
  const wav = join(workDirectory, 'clip.wav')
  try {
    writeFileSync(wav, audio)
    const { stdout } = await run(status.binary!,
      ['-m', status.model!, '-f', wav, '-nt', '--output-txt', '-of', join(workDirectory, 'out')],
      { env: agentEnv(), maxBuffer: 16 * 1024 * 1024 })
    const transcriptPath = join(workDirectory, 'out.txt')
    const text = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf8') : stdout
    return text.replace(/\[[^\]]*\]/g, '').trim()
  } finally {
    rmSync(workDirectory, { recursive: true, force: true })
  }
}

