import { expect, it } from 'vitest'
import { quiet } from '../src/lib/quiet.ts'

it('swallows what it is given', () => { expect(quiet()).toBeUndefined() })
