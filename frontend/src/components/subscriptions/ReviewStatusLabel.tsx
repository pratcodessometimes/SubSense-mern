import { Ban, CircleCheck, CircleDashed } from 'lucide-react'
import { clsx } from 'clsx'
import type { ReviewStatus } from '@/lib/types'

const config: Record<ReviewStatus, { label: string; icon: typeof Ban; className: string }> = {
  confirmed: { label: 'Confirmed by you', icon: CircleCheck, className: 'text-positive' },
  not_subscription: { label: 'Marked not a subscription', icon: Ban, className: 'text-ink-muted' },
  unreviewed: { label: 'Awaiting your review', icon: CircleDashed, className: 'text-ink-muted' },
}

/**
 * The user's review decision. Rendered as an icon + text label (not a pill) so it stays visually
 * distinct from the detection status badges such as "Price increased" or "Duplicate".
 */
export function ReviewStatusLabel({ status = 'unreviewed', className }: { status?: ReviewStatus; className?: string }) {
  const { label, icon: Icon, className: tone } = config[status] ?? config.unreviewed
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs font-medium', tone, className)}>
      <Icon size={13} aria-hidden="true" />
      {label}
    </span>
  )
}
