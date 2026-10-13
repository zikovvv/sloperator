import { useEffect, useRef, useState } from 'react'
import { useEscape } from '../lib/useEscape.ts'

/**
 * A one-field dialog. Electron does not implement window.prompt, so every prompt() call was
 * dead in the packaged app while working fine in the dev browser.
 */
export function TextPrompt({ title, label, placeholder, initial, confirmLabel, onCancel, onSubmit }: {
  title: string
  label: string
  placeholder?: string
  initial?: string
  confirmLabel?: string
  onCancel: () => void
  onSubmit: (value: string) => void
}) {
  useEscape(onCancel)
  const [value, setValue] = useState(initial ?? '')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { inputRef.current?.select() }, [])

  const submit = () => {
    if (value.trim()) onSubmit(value.trim())
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={onCancel}
         role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-[420px] rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-2xl"
           onClick={(event) => event.stopPropagation()}>
        <h2 className="mb-3 text-[14px] font-semibold">{title}</h2>
        <label className="label" htmlFor="text-prompt-field">{label}</label>
        <input
          id="text-prompt-field"
          ref={inputRef}
          autoFocus
          className="field mb-3 mt-1"
          placeholder={placeholder}
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); submit() }
          }}
        />
        <div className="flex justify-end gap-2">
          <button className="btn-quiet" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={submit} disabled={!value.trim()}>
            {confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
