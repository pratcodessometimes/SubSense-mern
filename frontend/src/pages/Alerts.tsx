import { AlertTriangle, Copy, Layers, TrendingDown } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { alerts as fallbackAlerts, subscriptions as fallbackSubscriptions } from '@/lib/mockData'
import { formatCurrency } from '@/lib/format'
import { listAlerts, listSubscriptions, type ApiAlert, type ApiSubscription } from '@/lib/api'
import type { Alert, AlertType, Subscription } from '@/lib/types'

const iconByType: Record<AlertType, typeof AlertTriangle> = {
  price_increase: TrendingDown,
  duplicate: Copy,
  unused: AlertTriangle,
  service_overlap: Layers,
}

function AlertCard({ alert, subscriptions }: { alert: Alert; subscriptions: Subscription[] }) {
  const Icon = iconByType[alert.type] || AlertTriangle
  const subs = alert.subscriptionIds
    .map((id) => subscriptions.find((s) => s.id === id || (s as unknown as { slug?: string }).slug === id)!)
    .filter(Boolean)
  const targetSub = subs[0]
  const isConfirmedDup = alert.subType === 'confirmed_duplicate' || (alert.type === 'duplicate' && (alert.duplicateAccounts?.length ?? 0) > 0)
  const isOverlap = alert.type === 'service_overlap' || alert.subType === 'service_overlap'
  const tone = alert.severity === 'critical' || isConfirmedDup ? 'danger' : 'warning'

  const prevAmount = alert.previousAmount ?? targetSub?.previousAmount
  const currAmount = alert.currentAmount ?? targetSub?.amount
  const isYearly = targetSub?.billingInterval === 'yearly'
  const intervalUnit = isYearly ? 'yr' : 'mo'

  const pct =
    alert.percentageChange ??
    (prevAmount && currAmount
      ? Math.round(((currAmount - prevAmount) / prevAmount) * 1000) / 10
      : undefined)

  const monthlyDiff =
    alert.monthlyImpact ??
    (prevAmount && currAmount
      ? isYearly
        ? Math.round(((currAmount - prevAmount) / 12) * 100) / 100
        : Math.round((currAmount - prevAmount) * 100) / 100
      : undefined)

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
          <div className="flex items-center justify-between">
            <span className="text-base font-semibold text-ink">{alert.title}</span>
            {alert.type === 'price_increase' && pct !== undefined && (
              <span className="inline-flex items-center rounded-full bg-danger-tint px-2.5 py-0.5 text-xs font-bold text-danger">
                +{pct}%
              </span>
            )}
            {isConfirmedDup && (
              <span className="inline-flex items-center rounded-full bg-danger-tint px-2.5 py-0.5 text-xs font-bold text-danger">
                Double Billing
              </span>
            )}
            {isOverlap && (
              <span className="inline-flex items-center rounded-full bg-warning-tint px-2.5 py-0.5 text-xs font-bold text-warning">
                Service Overlap
              </span>
            )}
          </div>

          {alert.type === 'price_increase' && prevAmount !== undefined && currAmount !== undefined && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              {targetSub && <span className="font-medium text-ink">{targetSub.name}</span>}
              <div className="inline-flex items-center gap-1.5 rounded-md bg-canvas px-2.5 py-1 text-xs">
                <span className="text-ink-muted line-through">{formatCurrency(prevAmount)}</span>
                <span className="text-ink-muted">→</span>
                <span className="font-bold text-ink">{formatCurrency(currAmount)}</span>
                <span className="text-ink-muted">/ {intervalUnit}</span>
              </div>
              {monthlyDiff !== undefined && (
                <span className="inline-flex items-center rounded-md border border-border bg-surface px-2 py-0.5 text-xs text-ink-muted">
                  Monthly: <strong className="ml-1 text-ink">+{formatCurrency(monthlyDiff)}/mo</strong>
                </span>
              )}
            </div>
          )}

          {isConfirmedDup && alert.duplicateAccounts && alert.duplicateAccounts.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-ink-muted">Accounts charged:</span>
              {alert.duplicateAccounts.map((acc) => (
                <span
                  key={acc}
                  className="rounded border border-danger/30 bg-danger-tint/50 px-2 py-0.5 font-medium text-danger"
                >
                  {acc}
                </span>
              ))}
            </div>
          )}

          {isOverlap && subs.length > 0 && (
            <div className="mt-2.5 flex flex-col gap-1.5 rounded-lg border border-border bg-canvas/40 p-2.5 text-xs">
              <span className="font-medium text-ink-muted">Overlapping active subscriptions:</span>
              <div className="flex flex-col gap-1">
                {subs.map((s) => (
                  <div key={s.id} className="flex items-center justify-between">
                    <span className="font-medium text-ink">{s.name}</span>
                    <span className="text-ink-muted">
                      {formatCurrency(s.amount)} / {s.billingInterval === 'yearly' ? 'year' : 'month'}
                      {s.billingInterval === 'yearly' && (
                        <span className="ml-1 text-ink-muted/80">
                          (~{formatCurrency(Math.round(s.amount / 12))}/mo)
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {alert.type === 'duplicate' && !isConfirmedDup && !isOverlap && (
            <div className="mt-2 flex flex-col gap-1 text-sm">
              {subs.map((s) => (
                <div key={s.id} className="flex items-center justify-between">
                  <span className="text-ink">{s.name}</span>
                  <span className="text-ink-muted">
                    {formatCurrency(s.amount)}/{s.billingInterval === 'yearly' ? 'year' : 'month'}
                  </span>
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
            {targetSub && (
              <Link to={`/subscriptions/${targetSub.id}`}>
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
  const [data, setData] = useState<Alert[]>(fallbackAlerts)
  const [subs, setSubs] = useState<Subscription[]>(fallbackSubscriptions)

  useEffect(() => {
    listAlerts()
      .then((res: ApiAlert[]) => {
        if (res && res.length > 0) {
          setData(
            res.map((a: ApiAlert) => ({
              id: a._id,
              type: a.type,
              subType: a.subType,
              severity: a.severity,
              title: a.title,
              description: a.description,
              subscriptionIds: a.subscriptionIds,
              serviceDomain: a.serviceDomain,
              duplicateAccounts: a.duplicateAccounts,
              impact: a.impact,
              impactLabel: a.impactLabel,
              previousAmount: a.previousAmount,
              currentAmount: a.currentAmount,
              percentageChange: a.percentageChange,
              monthlyImpact: a.monthlyImpact,
              annualImpact: a.annualImpact,
              isManual: a.isManual,
            })),
          )
        }
      })
      .catch(() => {})

    listSubscriptions()
      .then((res: ApiSubscription[]) => {
        if (res && res.length > 0) {
          setSubs(
            res.map((s: ApiSubscription) => ({
              id: s.slug || s._id,
              name: s.name,
              category: s.category,
              amount: s.amount,
              previousAmount: s.previousAmount,
              priceChangePct: s.priceChangePct,
              monthlyDifference: s.monthlyDifference,
              annualImpact: s.annualImpact,
              priceIncreaseDate: s.priceIncreaseDate,
              billingInterval: s.billingInterval,
              nextBillingDate: typeof s.nextBillingDate === 'string'
                ? s.nextBillingDate.slice(0, 10)
                : new Date(s.nextBillingDate).toISOString().slice(0, 10),
              status: s.status,
              transactionCount: s.transactionCount,
              confidence: s.confidence,
              serviceDomain: s.serviceDomain,
              hasDuplicateCharges: s.hasDuplicateCharges,
              duplicateAccounts: s.duplicateAccounts,
              overlappingWith: s.overlappingWith,
            })),
          )
        }
      })
      .catch(() => {})
  }, [])

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-bold text-ink">Alerts</h1>
        <p className="mt-1 text-base text-ink-muted">{data.length} things need your attention</p>
      </div>

      <div className="flex flex-col gap-4">
        {data.map((alert) => (
          <AlertCard key={alert.id} alert={alert} subscriptions={subs} />
        ))}
      </div>
    </div>
  )
}
