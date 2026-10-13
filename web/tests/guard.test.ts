import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchSiteIsAllowed, hostIsLocal, isInsideAny, originIsAllowed } from '../server/guard.ts'

describe('hostIsLocal — DNS rebinding defence', () => {
  it.each(['127.0.0.1:8787', 'localhost:8787', '[::1]:8787', 'localhost'])('accepts %s', (host) => {
    expect(hostIsLocal(host, 8787)).toBe(true)
  })
  it.each(['evil.example.com', 'evil.example.com:8787', 'attacker.localhost.evil.com:8787', undefined])(
    'rejects %s', (host) => expect(hostIsLocal(host as string | undefined, 8787)).toBe(false))
  it('accepts any port on a local name: dev servers and test runners proxy from their own', () => {
    expect(hostIsLocal('127.0.0.1:9999', 8787)).toBe(true)
    expect(hostIsLocal('localhost:5273', 8787)).toBe(true)
  })
  it('rejects a malformed host', () => {
    expect(hostIsLocal('\n', 8787)).toBe(false)
  })
})

describe('originIsAllowed', () => {
  it('allows the app itself and the Vite dev origin', () => {
    expect(originIsAllowed('http://localhost:8787', 8787)).toBe(true)
    expect(originIsAllowed('http://localhost:5273', 8787)).toBe(true)
    expect(originIsAllowed('http://[::1]:5299', 8787)).toBe(true)
    expect(originIsAllowed('not a url', 8787)).toBe(false)
    expect(originIsAllowed(undefined, 8787)).toBe(true)
  })
  it('rejects any cross-site origin, including a sandboxed null', () => {
    expect(originIsAllowed('https://evil.example.com', 8787)).toBe(false)
    expect(originIsAllowed('null', 8787)).toBe(false)
    expect(originIsAllowed('http://127.0.0.1.evil.example.com', 8787)).toBe(false)
  })
})

describe('fetchSiteIsAllowed', () => {
  it('refuses what a browser marks as cross-site — an <img>, a script or a link from another site — and nothing else', () => {
    expect(fetchSiteIsAllowed('cross-site')).toBe(false)
    for (const site of ['same-origin', 'same-site', 'none', undefined]) expect(fetchSiteIsAllowed(site)).toBe(true)
  })
})

describe('isInsideAny — path confinement', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-'))
  mkdirSync(join(root, 'project/sub'), { recursive: true })
  writeFileSync(join(root, 'project/sub/a.txt'), 'x')
  const outside = mkdtempSync(join(tmpdir(), 'outside-'))
  writeFileSync(join(outside, 'secret.txt'), 'x')

  it('accepts a file inside a root', () => {
    expect(isInsideAny(join(root, 'project/sub/a.txt'), [join(root, 'project')])).toBe(true)
  })
  it('accepts a file that does not exist yet inside a root', () => {
    expect(isInsideAny(join(root, 'project/sub/new.txt'), [join(root, 'project')])).toBe(true)
  })
  it('rejects traversal out of the root', () => {
    expect(isInsideAny(join(root, 'project/../../etc/passwd'), [join(root, 'project')])).toBe(false)
    expect(isInsideAny('/etc/passwd', [join(root, 'project')])).toBe(false)
  })
  it('rejects a symlink pointing outside the root', () => {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'project/link.txt'))
    expect(isInsideAny(join(root, 'project/link.txt'), [join(root, 'project')])).toBe(false)
  })
  it('rejects a sibling directory sharing a name prefix', () => {
    mkdirSync(join(root, 'project-evil'), { recursive: true })
    writeFileSync(join(root, 'project-evil/x.txt'), 'x')
    expect(isInsideAny(join(root, 'project-evil/x.txt'), [join(root, 'project')])).toBe(false)
  })
})
