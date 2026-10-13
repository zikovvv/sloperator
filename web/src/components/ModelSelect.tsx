import { useState } from 'react'
import type { EngineModels } from '../../shared/models.ts'

const MORE = '\u0000more'
const FEWER = '\u0000fewer'

/**
 * The engine's featured models, and "Other models…" which unfolds the whole catalog in place.
 * The model in use is always listed, even when the catalog no longer features it.
 */
export function ModelSelect({ engine, value, onChange }: { engine: EngineModels; value: string; onChange: (model: string) => void }) {
  const [unfolded, setUnfolded] = useState(false)
  const featured = engine.models.filter((model) => model.featured)
  const others = engine.models.filter((model) => !model.featured)
  const current = engine.models.find((model) => model.id === value)
  const shownFeatured = current || !value ? featured : [...featured, { id: value, label: value, featured: true }]
  const shownOthers = unfolded ? others : others.filter((model) => model.id === value)
  return (
    <select className="chip-button" aria-label="Model" value={value}
            onChange={(event) => {
              if (event.target.value === MORE) setUnfolded(true)
              else if (event.target.value === FEWER) setUnfolded(false)
              else onChange(event.target.value)
            }}>
      {shownFeatured.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
      {shownOthers.length > 0 && (
        <optgroup label="Other models">
          {shownOthers.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
        </optgroup>)}
      {others.length > 0 && (unfolded
        ? <option value={FEWER}>Fewer models…</option>
        : <option value={MORE}>Other models…</option>)}
    </select>
  )
}
