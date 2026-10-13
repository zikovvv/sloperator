// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelSelect } from '../../src/components/ModelSelect.tsx'

afterEach(() => cleanup())
const engine = { strongest: 'fable', models: [
  { id: 'fable', label: 'Fable 9', featured: true }, { id: 'opus', label: 'Opus 9', featured: true },
  { id: 'old-opus', label: 'Opus 8', featured: false }, { id: 'old-sonnet', label: 'Sonnet 8', featured: false },
] }
const labels = () => [...screen.getByLabelText('Model').querySelectorAll('option')].map((option) => option.textContent)

describe('ModelSelect', () => {
  it('offers the featured models and unfolds the others on request, then folds them back', () => {
    const onChange = vi.fn()
    render(<ModelSelect engine={engine} value="fable" onChange={onChange} />)
    expect(labels()).toEqual(['Fable 9', 'Opus 9', 'Other models…'])
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '\u0000more' } })
    expect(labels()).toEqual(['Fable 9', 'Opus 9', 'Opus 8', 'Sonnet 8', 'Fewer models…'])
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'old-opus' } })
    expect(onChange).toHaveBeenCalledWith('old-opus')
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: '\u0000fewer' } })
    expect(labels()).toEqual(['Fable 9', 'Opus 9', 'Other models…'])
  })

  it('always lists the model in use: an unfeatured one, or one the catalog no longer knows', () => {
    render(<ModelSelect engine={engine} value="old-sonnet" onChange={vi.fn()} />)
    expect(labels()).toEqual(['Fable 9', 'Opus 9', 'Sonnet 8', 'Other models…'])
    expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('old-sonnet')
    cleanup()
    render(<ModelSelect engine={engine} value="claude-retired" onChange={vi.fn()} />)
    expect(labels()).toEqual(['Fable 9', 'Opus 9', 'claude-retired', 'Other models…'])
    cleanup()
    render(<ModelSelect engine={{ strongest: 'fable', models: engine.models.filter((model) => model.featured) }} value="fable" onChange={vi.fn()} />)
    expect(labels()).toEqual(['Fable 9', 'Opus 9'])   // nothing else to unfold
  })
})
