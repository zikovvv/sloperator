import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { branches, defaultBranch, failureResult, gitResult } from '../server/git.ts'
import { collectEvents, projectOf } from '../server/usage.ts'
import { transcribe, voiceStatus } from '../server/voice.ts'
import { hover } from '../server/lsp.ts'

describe('git where there is no repository', () => {
  it('reports a folder that is not there in the error\'s own words, and has no branches to offer', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'orch-not-a-repo-'))
    expect((await gitResult(plain, ['status'])).ok).toBe(false)
    // What git said, else what the failure said: a spawn that never ran (no git at all) has no output.
    expect(failureResult({ stdout: 'out', stderr: 'bad', message: 'm' })).toEqual({ ok: false, stdout: 'out', stderr: 'bad' })
    expect(failureResult({ stdout: 'out', stderr: '', message: 'maxBuffer exceeded' })).toEqual({ ok: false, stdout: 'out', stderr: 'maxBuffer exceeded' })
    expect(failureResult(new Error('spawn /usr/bin/git ENOENT'))).toEqual({ ok: false, stdout: '', stderr: 'spawn /usr/bin/git ENOENT' })
    expect(await defaultBranch(plain)).toBe('main')
    expect(await branches(plain)).toEqual([])
  })
})

describe('usage files', () => {
  it('reads what a line lacks as unknown or zero, and steps over links that lead nowhere', async () => {
    expect(projectOf(`${process.env.ORCHESTRATOR_CLAUDE_PROJECTS}/`, '/Users/jane')).toBe('')
    const root = process.env.ORCHESTRATOR_CLAUDE_PROJECTS!
    const project = join(root, '-w-sweep')
    mkdirSync(project, { recursive: true })
    const stamp = new Date().toISOString()
    writeFileSync(join(project, 'thin.jsonl'), [
      JSON.stringify({ type: 'assistant', timestamp: stamp, message: { usage: { cache_read_input_tokens: 5 } } }),
      JSON.stringify({ type: 'assistant', timestamp: stamp, message: { model: 'claude-opus-5', id: 'm1', usage: { input_tokens: 3, output_tokens: 4 } } }),
    ].join('\n') + '\n')
    symlinkSync('/nowhere/ghost', join(project, 'ghost.jsonl'))
    const { events } = await collectEvents(Date.now() - 60_000)
    const thin = events.find((event) => event.project === 'w-sweep' && event.model === 'unknown')
    expect(thin).toMatchObject({ input: 0, output: 0, cacheRead: 5 })
    expect(events.some((event) => event.model === 'claude-opus-5' && event.input === 3)).toBe(true)
  })
})

describe('voice', () => {
  it('finds neither binary nor model when there is none, and refuses to transcribe without them', async () => {
    const savedBin = process.env.ORCHESTRATOR_BIN_DIR
    const savedModel = process.env.ORCHESTRATOR_WHISPER_MODEL
    try {
      process.env.ORCHESTRATOR_BIN_DIR = mkdtempSync(join(tmpdir(), 'orch-no-bin-'))
      expect(voiceStatus()).toMatchObject({ available: false, binary: null, hint: 'Install a local transcriber: brew install whisper-cpp' })
      await expect(transcribe(Buffer.from('RIFF....WAVE'))).rejects.toThrow(/Install a local transcriber/)
      process.env.ORCHESTRATOR_BIN_DIR = savedBin
      process.env.ORCHESTRATOR_WHISPER_MODEL = join(tmpdir(), 'no-such-model.bin')
      expect(voiceStatus()).toMatchObject({ available: false, model: null, hint: 'Download a model to ~/.cache/whisper/ggml-base.en.bin' })
      // Without the seams the real PATH and the usual model folders are searched; whatever is there is fine.
      delete process.env.ORCHESTRATOR_BIN_DIR
      delete process.env.ORCHESTRATOR_WHISPER_MODEL
      const status = voiceStatus()
      expect(status.binary === null || typeof status.binary === 'string').toBe(true)
      expect(status.model === null || typeof status.model === 'string').toBe(true)
    } finally {
      process.env.ORCHESTRATOR_BIN_DIR = savedBin
      process.env.ORCHESTRATOR_WHISPER_MODEL = savedModel
    }
  })
})

describe('language server frames', () => {
  it('copes with junk headers, split frames and notifications, and reports a hover the server refuses', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'orch-lsp-'))
    const file = join(workspace, 'a.py')
    writeFileSync(file, 'def x():\n    pass\n')
    expect(await hover(workspace, file, 96, 0)).toEqual({ text: null, error: null })
    expect(await hover(workspace, file, 95, 0)).toEqual({ text: null, error: 'hover exploded' })
    expect(await hover(workspace, file, 98, 0)).toEqual({ text: 'plain text hover', error: null })
  })
})
