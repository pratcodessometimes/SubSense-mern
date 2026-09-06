import { AlertTriangle, Copy, TrendingDown } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { alerts, subscriptions } from '@/lib/mockData'
import { formatCurrency } from '@/lib/format'
import type { Alert, AlertType } from '@/lib/types'

const iconByType: Record<AlertType, typeof AlertTriangle> = {
  price_increase: TrendingDown,
  duplicate: Copy,
  unused: AlertTriangle,
}

function AlertCard({ alert }: { alert: Alert }) {
  const Icon = iconByType[alert.type]
  const subs = alert.subscriptionIds.map((id) => subscriptions.find((s) => s.id === id)!).filter(Boolean)
  const tone = alert.severity === 'critical' ? 'danger' : 'warning'

  return (
    <Card>
      <div className="flex items-start gap-4">
        <div
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
            tone === 'danger' ? 'bg-danger-tint text-danger' : 'bg-warning-tint text-warning'
          }`}
        >
          <Icon size={18} />
        </div>
        <div className="flex-1">
          <div className="text-base font-semibold text-ink">{alert.title}</div>

          {alert.type === 'price_increase' && subs[0] && (
            <div className="mt-1 flex items-center gap-2 text-sm">
              <span className="font-medium text-ink">{subs[0].name}</span>
              <span className="text-ink-muted">
                {formatCurrency(subs[0].previousAmount ?? 0)} → {formatCurrency(subs[0].amount)}
              </span>
              <span className="font-semibold text-danger">
                +
                {Math.round(
                  (((subs[0].amount - (subs[0].previousAmount ?? subs[0].amount)) /
                    (subs[0].previousAmount ?? subs[0].amount)) *
                    100),
                )}
                %
              </span>
            </div>
          )}

          {alert.type === 'duplicate' && (
            <div className="mt-2 flex flex-col gap-1 text-sm">
              {subs.map((s) => (
                <div key={s.id} className="flex items-center justify-between">
                  <span className="text-ink">{s.name}</span>
                  <span className="text-ink-muted">{formatCurrency(s.amount)}/month</span>
                </div>
              ))}
            </div>
          )}

          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{alert.description}</p>

          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <div>
              <div className="text-xs text-ink-muted">{alert.impactLabel}</div>
              <div className="text-base font-bold text-ink">{alert.impact}</div>
            </div>
            {subs[0] && (
              <Link to={`/subscriptions/${subs[0].id}`}>
                <Button variant="secondary">Review</Button>
              </Link>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

export function Alerts() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-bold text-ink">Alerts</h1>
        <p className="mt-1 text-base text-ink-muted">{alerts.length} things need your attention</p>
      </div>

      <div className="flex flex-col gap-4">
        {alerts.map((alert) => (
          <AlertCard key={alert.id} alert={alert} />
        ))}
      </div>
    </div>
  )
}
