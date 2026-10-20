import { Activity, AlertTriangle, Clock, Copy, EyeOff, Layers, TrendingDown } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/format'
import { isAlertVisible } from '@/lib/alertPreferences'
import { listAlerts, listSubscriptions, type ApiAlert, type ApiSubscription } from '@/lib/api'
import { useAuth } from '@/lib/authContext'
import type { Alert, AlertType, Subscription } from '@/lib/types'

const iconByType: Record<AlertType, typeof AlertTriangle> = {
  price_increase: TrendingDown,
  duplicate: Copy,
  unused: AlertTriangle,
  service_overlap: Layers,
  inactivity_review: Clock,
  payment_anomaly: Activity,
}

function AlertCard({ alert, subscriptions }: { alert: Alert; subscriptions: Subscription[] }) {
  const Icon = iconByType[alert.type] || AlertTriangle
  const subs = alert.subscriptionIds
    .map((id) => subscriptions.find((s) => s.id === id || (s as unknown as { slug?: string }).slug === id)!)
    .filter(Boolean)
  const targetSub = subs[0]

  const isConfirmedDup =
    alert.subType === 'confirmed_duplicate' ||
    (alert.type === 'duplicate' && (alert.duplicateAccounts?.length ?? 0) >= 2)
  const isSuspectedDup = alert.subType === 'suspected_duplicate'
  const isOverlap = alert.type === 'service_overlap' || alert.subType === 'service_overlap'
  const isInactivity = alert.type === 'inactivity_review' || alert.type === 'unused'
  const isNeedsReview = alert.subType === 'needs_review'
  const isAnomaly = alert.type === 'payment_anomaly'
  const isTimingAnomaly = isAnomaly && alert.subType === 'unusual_timing'

  let tone: 'danger' | 'warning' | 'info' = 'warning'
  if (alert.severity === 'critical' || isConfirmedDup) {
    tone = 'danger'
  } else if (isNeedsReview || alert.severity === 'info') {
    tone = 'info'
  }

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
            tone === 'danger'
              ? 'bg-danger-tint text-danger'
              : tone === 'info'
                ? 'bg-primary-tint text-primary'
                : 'bg-warning-tint text-warning'
          }`}
        >
          <Icon size={18} />
        </div>
        <div className="flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-base font-semibold text-ink">{alert.title}</span>
            <div className="flex flex-wrap items-center gap-1.5">
              {alert.type === 'price_increase' && pct !== undefined && (
                <span className="inline-flex items-center rounded-full bg-danger-tint px-2.5 py-0.5 text-xs font-bold text-danger">
                  +{pct}%
                </span>
              )}
              {isConfirmedDup && (
                <span className="inline-flex items-center rounded-full bg-danger-tint px-2.5 py-0.5 text-xs font-bold text-danger">
                  Confirmed Double Billing
                </span>
              )}
              {isSuspectedDup && (
                <span className="inline-flex items-center rounded-full bg-warning-tint px-2.5 py-0.5 text-xs font-bold text-warning">
                  Suspected Duplicate
                </span>
              )}
              {isOverlap && (
                <span className="inline-flex items-center rounded-full bg-warning-tint px-2.5 py-0.5 text-xs font-bold text-warning">
                  Service Overlap
                </span>
              )}
              {isInactivity && (
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${
                    isNeedsReview
                      ? 'bg-primary-tint text-primary'
                      : 'bg-warning-tint text-warning'
                  }`}
                >
                  {isNeedsReview ? 'Cadence Review' : 'Activity Missing'}
                </span>
              )}
              {isAnomaly && (
                <span className="inline-flex items-center rounded-full bg-primary-tint px-2.5 py-0.5 text-xs font-bold text-primary">
                  {isTimingAnomaly ? 'Unusual Timing' : 'Unusual Amount'}
                </span>
              )}
              {alert.confidenceLabel && (
                <span className="inline-flex items-center rounded border border-border bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-muted">
                  {alert.confidenceLabel}
                </span>
              )}
            </div>
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
                  Monthly impact: <strong className="ml-1 text-ink">+{formatCurrency(monthlyDiff)}/mo</strong>
                </span>
              )}
            </div>
          )}

          {alert.type === 'duplicate' && alert.duplicateAccounts && alert.duplicateAccounts.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <span className="text-ink-muted">Accounts charged:</span>
              {alert.duplicateAccounts.map((acc) => (
                <span
                  key={acc}
                  className={`rounded border px-2 py-0.5 font-medium ${
                    isConfirmedDup
                      ? 'border-danger/30 bg-danger-tint/50 text-danger'
                      : 'border-warning/30 bg-warning-tint/50 text-warning'
                  }`}
                >
                  {acc}
                </span>
              ))}
            </div>
          )}

          {isInactivity && (alert.lastPaymentDate || alert.expectedBillingDate) && (
            <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-lg border border-border bg-canvas/40 p-2.5 text-xs">
              <div>
                <span className="text-ink-muted">Last Recorded Payment:</span>
                <div className="font-semibold text-ink">
                  {alert.lastPaymentDate ? formatDate(alert.lastPaymentDate) : 'Unknown'}
                  {alert.daysSinceLastPayment !== undefined && (
                    <span className="ml-1 text-ink-muted font-normal">({alert.daysSinceLastPayment}d ago)</span>
                  )}
                </div>
              </div>
              <div>
                <span className="text-ink-muted">Expected Renewal Date:</span>
                <div className="font-semibold text-ink">
                  {alert.expectedBillingDate ? formatDate(alert.expectedBillingDate) : 'Unknown'}
                  {alert.daysOverdue !== undefined && alert.daysOverdue > 0 && (
                    <span className="ml-1 text-warning font-normal">({alert.daysOverdue}d overdue)</span>
                  )}
                </div>
              </div>
              <div>
                <span className="text-ink-muted">Evidence Evaluation:</span>
                <div className="font-semibold text-ink">
                  {isNeedsReview ? 'Limited history — verify cadence' : 'Missing beyond grace period'}
                </div>
              </div>
            </div>
          )}

          {isAnomaly && (
            <div className="mt-2.5 grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-lg border border-border bg-canvas/40 p-2.5 text-xs">
              <div>
                <span className="text-ink-muted">Payment:</span>
                <div className="font-semibold text-ink">
                  {alert.currentAmount !== undefined ? formatCurrency(alert.currentAmount) : '—'}
                  {alert.paymentDate && <span className="ml-1 font-normal text-ink-muted">on {formatDate(alert.paymentDate)}</span>}
                </div>
              </div>
              <div>
                <span className="text-ink-muted">{isTimingAnomaly ? 'Gap since previous charge:' : 'Usual amount:'}</span>
                <div className="font-semibold text-ink">
                  {isTimingAnomaly
                    ? `${alert.actualIntervalDays ?? '—'} days (usually ~${alert.expectedIntervalDays !== undefined ? Math.round(alert.expectedIntervalDays) : '—'})`
                    : alert.expectedAmount !== undefined
                      ? formatCurrency(alert.expectedAmount)
                      : '—'}
                </div>
              </div>
              <div>
                <span className="text-ink-muted">How this was detected:</span>
                <div className="font-semibold text-ink">Explainable ML · robust deviation from the previous payments</div>
              </div>
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

          <p className="mt-2 text-sm leading-relaxed text-ink-muted">{alert.description}</p>

          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <div>
              <div className="text-xs text-ink-muted">{alert.impactLabel}</div>
              <div className="text-base font-bold text-ink">{alert.impact}</div>
            </div>
            {targetSub && (
              <Link to={`/subscriptions/${targetSub.id}`}>
                <Button variant="secondary">Review Subscription</Button>
              </Link>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

export function Alerts() {
  const { user } = useAuth()
  const [data, setData] = useState<Alert[]>([])
  const [subs, setSubs] = useState<Subscription[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    Promise.all([listAlerts(), listSubscriptions()])
      .then(([alertRes, subRes]) => {
        if (alertRes) {
          setData(
            alertRes.map((a: ApiAlert) => ({
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
              daysSinceLastPayment: a.daysSinceLastPayment,
              daysOverdue: a.daysOverdue,
              expectedBillingDate: a.expectedBillingDate,
              lastPaymentDate: a.lastPaymentDate,
              confidenceLabel: a.confidenceLabel,
              isManual: a.isManual,
              anomalyReason: a.anomalyReason,
              anomalyScore: a.anomalyScore,
              expectedAmount: a.expectedAmount,
              expectedIntervalDays: a.expectedIntervalDays,
              actualIntervalDays: a.actualIntervalDays,
              paymentDate: a.paymentDate,
              detectorVersion: a.detectorVersion,
            })),
          )
        }
        if (subRes) {
          setSubs(
            subRes.map((s: ApiSubscription) => ({
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
              nextBillingDate:
                typeof s.nextBillingDate === 'string'
                  ? s.nextBillingDate.slice(0, 10)
                  : new Date(s.nextBillingDate).toISOString().slice(0, 10),
              status: s.status,
              transactionCount: s.transactionCount,
              confidence: s.confidence,
              serviceDomain: s.serviceDomain,
              hasDuplicateCharges: s.hasDuplicateCharges,
              duplicateAccounts: s.duplicateAccounts,
              duplicateAmount: s.duplicateAmount,
              duplicateConfidence: s.duplicateConfidence,
              daysSinceLastPayment: s.daysSinceLastPayment,
              daysOverdue: s.daysOverdue,
              inactivityReason: s.inactivityReason,
              inactivityEvidence: s.inactivityEvidence,
              overlappingWith: s.overlappingWith,
              reviewStatus: s.reviewStatus,
            })),
          )
        }
      })
      .catch((err) => {
        console.error('Failed to load alerts from backend:', err)
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [])

  // Phase 4.2: display-only filtering by the user's alert visibility preferences. Hidden alerts
  // are still stored and analysed, and reappear when the category is switched back on.
  const prefs = user?.preferences.alerts
  const visible = useMemo(() => data.filter((a) => isAlertVisible(a, prefs)), [data, prefs])
  const hiddenCount = data.length - visible.length

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-bold text-ink">Alerts & Intelligence</h1>
        <p className="mt-1 text-base text-ink-muted">
          {visible.length} recurring expense findings requiring your attention
        </p>
      </div>

      {!isLoading && hiddenCount > 0 && visible.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-ink-muted">
          <EyeOff size={15} />
          {hiddenCount} {hiddenCount === 1 ? 'alert is' : 'alerts are'} hidden by your alert visibility settings.
          <Link to="/settings" className="font-semibold text-primary hover:text-primary-hover">
            Manage
          </Link>
        </div>
      )}

      {isLoading ? (
        <Card className="py-12 text-center text-sm text-ink-muted">Loading alerts…</Card>
      ) : data.length === 0 ? (
        <Card className="py-12 text-center text-sm text-ink-muted">
          No active alerts detected. All subscriptions are current with no duplicate billing or price changes.
        </Card>
      ) : visible.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-12 text-center">
          <EyeOff size={22} className="text-ink-muted" />
          <p className="text-sm text-ink-muted">
            All {hiddenCount} {hiddenCount === 1 ? 'alert is' : 'alerts are'} in categories you've hidden. SubSense is
            still tracking them.
          </p>
          <Link to="/settings">
            <Button variant="secondary">Change alert visibility</Button>
          </Link>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {visible.map((alert) => (
            <AlertCard key={alert.id} alert={alert} subscriptions={subs} />
          ))}
        </div>
      )}
    </div>
  )
}
