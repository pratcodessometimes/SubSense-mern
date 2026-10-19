import { useState } from 'react'
import { clsx } from 'clsx'

interface SwitchProps {
  /** Uncontrolled initial state (ignored when `checked` is provided). */
  defaultChecked?: boolean
  /** Controlled state: the switch shows exactly this value. */
  checked?: boolean
  onChange?: (checked: boolean) => void
  disabled?: boolean
  label?: string
}

export function Switch({ defaultChecked = false, checked, onChange, disabled = false, label }: SwitchProps) {
  const [internal, setInternal] = useState(defaultChecked)
  const isControlled = checked !== undefined
  const value = isControlled ? checked : internal

  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        if (!isControlled) setInternal(!value)
        onChange?.(!value)
      }}
      className={clsx(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        value ? 'bg-primary' : 'bg-border',
      )}
    >
      <span
        className={clsx(
          // left-0 anchors the knob; without it the button's centered text flow offsets it off the track.
          'absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
          value ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}
