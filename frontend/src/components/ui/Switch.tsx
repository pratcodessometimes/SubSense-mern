import { useState } from 'react'
import { clsx } from 'clsx'

export function Switch({ defaultChecked = false }: { defaultChecked?: boolean }) {
  const [checked, setChecked] = useState(defaultChecked)

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => setChecked((c) => !c)}
      className={clsx(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors',
        checked ? 'bg-primary' : 'bg-border',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
