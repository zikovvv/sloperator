import { useEscape } from '../lib/useEscape.ts'
/**
 * In-app confirmation. window.confirm is auto-dismissed by headless browsers and handled
 * unreliably by Electron, so "Delete" did nothing without any error.
 */
export function ConfirmDialog({ title, body, confirmLabel, danger, onCancel, onConfirm }: {
  title: string
  body?: string
  confirmLabel?: string
  danger?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  useEscape(onCancel)
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onClick={onCancel}
         role="alertdialog" aria-modal="true" aria-label={title}>
      <div className="w-[420px] rounded-xl border border-ink-700 bg-ink-900 p-4 shadow-2xl"
           onClick={(event) => event.stopPropagation()}>
        <h2 className="mb-2 text-[14px] font-semibold">{title}</h2>
        {body && <p className="mb-4 text-[12px] text-ink-300">{body}</p>}
        <div className="flex justify-end gap-2">
          <button className="btn-quiet" onClick={onCancel} autoFocus>Cancel</button>
          <button className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm}>
            {confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </div>
  )
}
