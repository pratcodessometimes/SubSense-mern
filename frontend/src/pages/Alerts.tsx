import { AlertTriangle, Clock, Copy, Loader2, TrendingDown, TrendingUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { formatCurrency } from '@/lib/format'
import { listAlerts, listSubscriptions, type ApiAlert, type ApiSubscription, type AlertType } from '@/lib/api'

const iconByType: Record<AlertType, typeof AlertTriangle> = {
  price_increase: TrendingDown,
  trial_conversion: TrendingUp,
  cadence_drift: Clock,
  duplicate: Copy,
  unused: AlertTriangle,
}

function AlertCard({ alert, subscriptions }: { alert: ApiAlert; subscriptions: ApiSubscription[] }) {
  const Icon = iconByType[alert.type]
  const subs = alert.subscriptionIds.map((id) => subscriptions.find((s) => s.id === id)).filter((s): s is ApiSubscription => Boolean(s))
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

          {(alert.type === 'price_increase' || alert.type === 'trial_conversion') && subs[0] && (
            <div className="mt-1 flex items-center gap-2 text-sm">
              <span className="font-medium text-ink">{subs[0].name}</span>
              <span className="text-ink-muted">
                {formatCurrency(subs[0].previousAmount ?? 0)} → {formatCurrency(subs[0].amount)}
              </span>
              <span className="font-semibold text-danger">
                +
                {Math.round(
                  ((subs[0].amount - (subs[0].previousAmount ?? subs[0].amount)) /
                    (subs[0].previousAmount ?? subs[0].amount)) *
                    100,
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
  const [alerts, setAlerts] = useState<ApiAlert[]>([])
  const [subscriptions, setSubscriptions] = useState<ApiSubscription[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    setError(null)
    Promise.all([listAlerts(), listSubscriptions()])
      .then(([alertList, subs]) => {
        setAlerts(alertList)
        setSubscriptions(subs)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load alerts'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-bold text-ink">Alerts</h1>
        <p className="mt-1 text-base text-ink-muted">
          {loading ? 'Loading…' : `${alerts.length} thing${alerts.length === 1 ? '' : 's'} need your attention`}
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger-tint px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-ink-muted">
          <Loader2 size={18} className="animate-spin" />
          Loading alerts…
        </div>
      ) : alerts.length === 0 ? (
        <Card className="py-12 text-center text-sm text-ink-muted">
          No alerts right now — nothing looks off with your recurring spend.
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {alerts.map((alert) => (
            <AlertCard key={alert.id} alert={alert} subscriptions={subscriptions} />
          ))}
        </div>
      )}
    </div>
  )
}
