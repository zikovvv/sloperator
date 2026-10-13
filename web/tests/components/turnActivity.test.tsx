// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TurnActivity } from '../../src/components/TurnActivity.tsx'

afterEach(() => cleanup())
const now = 100_000
const base = { agents: [], running: true, startedAt: 1, now, onKill: vi.fn() }

describe('TurnActivity', () => {
  it('opens a running tool call to its whole input, a finished one to what it printed', () => {
    render(<TurnActivity {...base} finished={[
      { id: 'f1', name: 'Bash', detail: 'npm test', input: { command: 'npm test' }, startedAt: 1000, endedAt: 66_000, output: '', failed: true },
      { id: 'f2', name: 'Read', detail: 'a.py', startedAt: 1000, endedAt: 2000, output: '', failed: false },
    ]} tools={[
      { id: 't1', name: 'Bash', detail: 'git log', input: { command: 'git log --oneline\n| head' }, startedAt: now - 5000 },
      { id: 't2', name: 'shell', detail: 'make\nall', startedAt: now - 1000 },
      { id: 't3', name: 'Edit', detail: 'x.py', startedAt: now - 1000 },
      { id: 't4', name: 'WebSearch', detail: '', startedAt: now - 1000 },
    ]} processes={[]} />)
    expect(screen.getAllByTestId('running-tool')[3].textContent).toContain('WebSearch')   // named by the tool when nothing else is known
    const running = screen.getAllByTestId('running-tool')
    expect(running[0].textContent).toContain('git log --oneline'); expect(running[0].textContent).toContain('5s')
    fireEvent.click(running[0].querySelector('button')!)
    expect(running[0].textContent).toContain('| head')            // the whole command, not its first line
    fireEvent.click(running[1].querySelector('button')!)          // a bare multi-line detail opens too
    expect(running[1].textContent).toContain('all')
    fireEvent.click(running[2].querySelector('button')!)          // nothing more to show than the line itself
    expect(running[2].querySelector('pre')).toBeNull()
    const finished = screen.getAllByTestId('finished-tool')        // newest first
    expect(finished[0].textContent).toContain('Read'); expect(finished[0].textContent).toContain('1s')
    expect(finished[1].textContent).toContain('1m 5s')
    fireEvent.click(finished[1].querySelector('button')!)
    expect(screen.getByTestId('tool-output').textContent).toBe('failed')
    fireEvent.click(finished[0].querySelector('button')!)
    expect(screen.getAllByTestId('tool-output')[0].textContent).toBe('no output')
  })

  it('shows every process with its share of the machine, marks the commands, and kills one on request', () => {
    const onKill = vi.fn()
    render(<TurnActivity {...base} onKill={onKill} tools={[]} finished={[]} processes={[
      { pid: 42, ppid: 1, command: '/bin/bash -c "npm test -- --watch"', depth: 1, elapsed: 65, cpu: 0.4 },
      { pid: 43, ppid: 42, command: 'node vitest', depth: 2, elapsed: 3661, cpu: 97.6 },
    ]} />)
    const rows = screen.getAllByTestId('process')
    expect(rows[0].textContent).toContain('command'); expect(rows[0].textContent).toContain('1m 5s · 0% cpu')
    expect(rows[1].textContent).not.toContain('command'); expect(rows[1].textContent).toContain('1h 1m · 98% cpu')
    fireEvent.click(screen.getByText('node vitest'))
    expect(screen.getByText('node vitest').className).toContain('whitespace-pre-wrap')
    fireEvent.click(rows[1].querySelector('.btn-danger')!)
    expect(onKill).toHaveBeenCalledWith(43)
  })

  it('shows a subagent whole: its prompt and every line, none cut short', () => {
    render(<TurnActivity {...base} running={false} tools={[]} finished={[]} processes={[]} agents={[
      { id: 'abcdef123', updatedAt: 2000, idleMS: 5, prompt: 'Look around\nmore', truncated: false,
        rows: [{ role: 'tool', text: 'Bash cat a-very-long-file-name.txt' }] },
    ]} />)
    const agent = screen.getByTestId('subagent')
    expect(agent.textContent).toContain('more'); expect(agent.textContent).toContain('finished')
    expect(agent.querySelector('.font-mono.text-ink-400')!.className).toContain('whitespace-pre-wrap')
  })
})
