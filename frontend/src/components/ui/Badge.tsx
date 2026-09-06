import type { ReactNode } from 'react'
import { clsx } from 'clsx'

type Tone = 'active' | 'warning' | 'critical' | 'neutral' | 'primary'

const toneClasses: Record<Tone, string> = {
  active: 'bg-positive-tint text-positive',
  warning: 'bg-warning-tint text-warning',
  critical: 'bg-danger-tint text-danger',
  neutral: 'bg-canvas text-ink-muted',
  primary: 'bg-primary-tint text-primary',
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        toneClasses[tone],
      )}
    >
      {children}
    </span>
  )
}
