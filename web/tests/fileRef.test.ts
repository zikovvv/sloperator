import { describe, expect, it } from 'vitest'
import { inWorktree, matchChanged, parseFileRef } from '../src/lib/fileRef.ts'

describe('file references in chat text', () => {
  it('reads the line off a reference in every form an agent writes it', () => {
    expect(parseFileRef('src/a.py')).toEqual({ path: 'src/a.py' })
    expect(parseFileRef('src/a.py:12')).toEqual({ path: 'src/a.py', line: 12 })
    expect(parseFileRef('src/a.py:12-20')).toEqual({ path: 'src/a.py', line: 12 })
    expect(parseFileRef('/abs/a.py:12:3')).toEqual({ path: '/abs/a.py', line: 12 })
    expect(parseFileRef('src/a.py#L12')).toEqual({ path: 'src/a.py', line: 12 })
    expect(parseFileRef('src/a.py#L12-L20')).toEqual({ path: 'src/a.py', line: 12 })
    expect(parseFileRef('notes: draft.md')).toEqual({ path: 'notes: draft.md' })
  })

  it('finds the changed file a reference means', () => {
    const changed = ['web/server/app.ts', 'web/src/App.tsx', 'docs/app.ts']
    expect(matchChanged('web/server/app.ts', changed)).toBe('web/server/app.ts')
    expect(matchChanged('./web/src/App.tsx', changed)).toBe('web/src/App.tsx')
    // An absolute path, from whatever checkout: the changed file it ends with, the longest one.
    expect(matchChanged('/Users/x/other-checkout/web/server/app.ts', changed)).toBe('web/server/app.ts')
    expect(matchChanged('/x/web/server/app.ts', ['server/app.ts', ...changed])).toBe('web/server/app.ts')   // both end it: the longer
    // A bare name is taken only when exactly one changed file ends with it.
    expect(matchChanged('App.tsx', changed)).toBe('web/src/App.tsx')
    expect(matchChanged('app.ts', changed)).toBeNull()
    expect(matchChanged('README.md', changed)).toBeNull()
  })

  it('reads a path in this worktree, moving one written against another checkout of the project onto it', () => {
    const others = ['/repo', '/wt/one', '/wt/one-more']
    expect(inWorktree('src/a.py', '/wt/two', others)).toBe('/wt/two/src/a.py')
    expect(inWorktree('./src/a.py', '/wt/two', others)).toBe('/wt/two/src/a.py')
    expect(inWorktree('/wt/two/src/a.py', '/wt/two', others)).toBe('/wt/two/src/a.py')
    expect(inWorktree('/repo/src/a.py', '/wt/two', others)).toBe('/wt/two/src/a.py')
    expect(inWorktree('/wt/one-more/src/a.py', '/wt/two', others)).toBe('/wt/two/src/a.py')   // the longest root, not "/wt/one"
    expect(inWorktree('/repo/nested/src/a.py', '/wt/two', ['/repo', '/repo/nested'])).toBe('/wt/two/src/a.py')   // a checkout inside another
    expect(inWorktree('/etc/hosts', '/wt/two', others)).toBe('/etc/hosts')
  })
})
