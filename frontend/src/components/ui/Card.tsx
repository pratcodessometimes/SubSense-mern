import type { HTMLAttributes } from 'react'
import { clsx } from 'clsx'

export function Card({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={clsx(
        'rounded-2xl border border-border bg-surface p-5 shadow-[var(--shadow-card-soft)]',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  )
}
