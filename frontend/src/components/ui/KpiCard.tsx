import type { ReactNode } from 'react'
import { clsx } from 'clsx'
import { Card } from './Card'

interface KpiCardProps {
  label: string
  value: string
  trend?: { value: string; direction: 'up' | 'down'; good: boolean }
  caption?: string
  icon?: ReactNode
}

export function KpiCard({ label, value, trend, caption, icon }: KpiCardProps) {
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink-muted">{label}</span>
        {icon && <span className="text-ink-muted">{icon}</span>}
      </div>
      <span className="text-[28px] font-bold leading-none text-ink">{value}</span>
      <div className="flex items-center gap-1.5 text-xs">
        {trend && (
          <span className={clsx('font-semibold', trend.good ? 'text-positive' : 'text-danger')}>
            {trend.direction === 'up' ? '↑' : '↓'} {trend.value}
          </span>
        )}
        {caption && <span className="text-ink-muted">{caption}</span>}
      </div>
    </Card>
  )
}
