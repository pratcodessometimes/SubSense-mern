import { AlertTriangle, ArrowRight, Clock, Copy, Layers, PiggyBank, Repeat, Sparkles, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { MonthlySpendChart } from '@/components/analytics/MonthlySpendChart'
import { Card } from '@/components/ui/Card'
import { KpiCard } from '@/components/ui/KpiCard'
import { ImpactLine } from '@/components/insights/RecommendationCard'
import { formatCurrency, formatDate } from '@/lib/format'
import {
  getDashboardKpis,
  getMonthlyAnalytics,
  getRecommendations,
  listSubscriptions,
  type ApiSubscription,
  type DashboardKpis,
  type MonthlyAnalytics,
  type RecommendationsResponse,
} from '@/lib/api'
import { CATEGORY_META } from '@/lib/recommendations'
import { useAuth } from '@/lib/authContext'
import type { Subscription } from '@/lib/types'

function mapApiSub(apiSub: ApiSubscription): Subscription {
  return {
    id: apiSub.slug || apiSub._id,
    name: apiSub.name,
    category: apiSub.category,
    amount: apiSub.amount,
    previousAmount: apiSub.previousAmount,
    priceChangePct: apiSub.priceChangePct,
    monthlyDifference: apiSub.monthlyDifference,
    annualImpact: apiSub.annualImpact,
    priceIncreaseDate: apiSub.priceIncreaseDate,
    billingInterval: apiSub.billingInterval,
    nextBillingDate:
      typeof apiSub.nextBillingDate === 'string'
        ? apiSub.nextBillingDate.slice(0, 10)
        : new Date(apiSub.nextBillingDate).toISOString().slice(0, 10),
    status: apiSub.status,
    transactionCount: apiSub.transactionCount,
    confidence: apiSub.confidence,
    lastActivity: apiSub.lastActivity,
    serviceDomain: apiSub.serviceDomain,
    hasDuplicateCharges: apiSub.hasDuplicateCharges,
    duplicateAccounts: apiSub.duplicateAccounts,
    duplicateAmount: apiSub.duplicateAmount,
    duplicateConfidence: apiSub.duplicateConfidence,
    daysSinceLastPayment: apiSub.daysSinceLastPayment,
    daysOverdue: apiSub.daysOverdue,
    inactivityReason: apiSub.inactivityReason,
    inactivityEvidence: apiSub.inactivityEvidence,
    overlappingWith: apiSub.overlappingWith,
    reviewStatus: apiSub.reviewStatus,
  }
}

export function Dashboard() {
  const { user } = useAuth()
  const firstName = user?.name.split(/\s+/)[0]
  const [kpis, setKpis] = useState<DashboardKpis | null>(null)
  const [subs, setSubs] = useState<Subscription[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [recs, setRecs] = useState<RecommendationsResponse | null>(null)
  const [recsFailed, setRecsFailed] = useState(false)
  // Phase 5.1: the trend chart uses the same per-user series as the Analytics page.
  const [trend, setTrend] = useState<MonthlyAnalytics['actual'] | null>(null)
  const [trendFailed, setTrendFailed] = useState(false)

  useEffect(() => {
    getMonthlyAnalytics(12)
      .then((res) => setTrend(res.actual))
      .catch(() => setTrendFailed(true))
  }, [])

  // Phase 4.3: top recommendations, loaded independently so a failure never blocks the KPIs.
  useEffect(() => {
    getRecommendations()
      .then(setRecs)
      .catch(() => setRecsFailed(true))
  }, [])

  useEffect(() => {
    Promise.all([getDashboardKpis(), listSubscriptions()])
      .then(([kpiRes, subRes]) => {
        if (kpiRes) setKpis(kpiRes)
        if (subRes) setSubs(subRes.map(mapApiSub))
      })
      .catch((err) => {
        console.error('Failed to load dashboard data:', err)
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [])

  const upcoming = [...subs]
    .filter((s) => s.status !== 'confirmed_cancelled' && s.reviewStatus !== 'not_subscription')
    .sort((a, b) => new Date(a.nextBillingDate).getTime() - new Date(b.nextBillingDate).getTime())
    .slice(0, 4)

  const spendTrend =
    kpis?.monthlySpendChangePct !== null && kpis?.monthlySpendChangePct !== undefined
      ? {
          value: `${kpis.monthlySpendChangePct > 0 ? '+' : ''}${kpis.monthlySpendChangePct}%`,
          direction: (kpis.monthlySpendChangePct <= 0 ? 'down' : 'up') as 'up' | 'down',
          good: kpis.monthlySpendChangePct <= 0,
        }
      : undefined

  const newSubCaption =
    kpis?.newThisMonth !== null && kpis?.newThisMonth !== undefined
      ? `${kpis.newThisMonth} new this month`
      : 'Baseline history active'

  const savings = kpis?.savingsBreakdown

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[28px] font-bold text-ink sm:text-[32px]">Good morning{firstName ? `, ${firstName}` : ''}</h1>
        <p className="mt-1 text-base text-ink-muted">
          Here&apos;s what&apos;s happening with your recurring spending and financial intelligence.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Monthly recurring spend"
          value={kpis ? formatCurrency(kpis.monthlySpend) : '—'}
          trend={spendTrend}
          caption={spendTrend ? 'vs last month' : 'Derived from recurring payments'}
          icon={<Wallet size={18} />}
        />
        <KpiCard
          label="Active subscriptions"
          value={kpis ? String(kpis.activeSubscriptions) : '—'}
          caption={newSubCaption}
          icon={<Repeat size={18} />}
        />
        <KpiCard
          label="Possible savings (estimate)"
          value={kpis ? `${formatCurrency(kpis.potentialSavings)}/mo` : '—'}
          caption={kpis ? 'Duplicate charges + optional consolidation' : 'Analyzing patterns'}
          icon={<PiggyBank size={18} />}
        />
        <KpiCard
          label="Alerts"
          value={kpis ? String(kpis.alertCount) : '—'}
          caption={
            kpis
              ? `${kpis.priceIncreaseAlerts} price · ${kpis.duplicateAlerts} dup · ${kpis.inactivityAlerts ?? 0} inactive · ${kpis.anomalyAlerts ?? 0} unusual`
              : 'Monitoring cadence'
          }
          icon={<AlertTriangle size={18} />}
        />
      </div>

      {savings &&
        ((savings.duplicateExposure ?? savings.confirmedSavings) > 0 ||
          savings.conditionalSavings > 0 ||
          (savings.inactivityReviewAmount ?? savings.inactivitySavings) > 0) && (
        <Card className="border-primary/20 bg-primary-tint/20">
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <PiggyBank className="h-5 w-5 text-primary" />
                <h3 className="text-sm font-bold text-ink">Savings Estimate Breakdown</h3>
              </div>
              <span className="text-xs text-ink-muted">Per month · only the first two count toward the estimate</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-xs">
              <div className="rounded-lg border border-border bg-surface p-2.5">
                <div className="flex items-center gap-1.5 font-semibold text-danger">
                  <Copy size={13} className="text-danger" />
                  Duplicate Billing Exposure
                </div>
                <div className="mt-1 text-base font-bold text-ink">
                  {formatCurrency(savings.duplicateExposure ?? savings.confirmedSavings)}/mo
                </div>
                <div className="mt-0.5 text-[11px] text-ink-muted">Extra charges with strong evidence — verify with your statements</div>
              </div>
              <div className="rounded-lg border border-border bg-surface p-2.5">
                <div className="flex items-center gap-1.5 font-semibold text-warning">
                  <Layers size={13} className="text-warning" />
                  Conditional Consolidation
                </div>
                <div className="mt-1 text-base font-bold text-ink">{formatCurrency(savings.conditionalSavings)}/mo</div>
                <div className="mt-0.5 text-[11px] text-ink-muted">Only if you keep one service per overlapping group</div>
              </div>
              <div className="rounded-lg border border-border bg-surface p-2.5">
                <div className="flex items-center gap-1.5 font-semibold text-ink-muted">
                  <Clock size={13} className="text-ink-muted" />
                  Missing-Payment Review
                </div>
                <div className="mt-1 text-base font-bold text-ink">
                  {formatCurrency(savings.inactivityReviewAmount ?? savings.inactivitySavings)}/mo
                </div>
                <div className="mt-0.5 text-[11px] text-ink-muted">Not a saving — expected payments were not observed</div>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold text-ink">Recurring Spend Trend</h2>
          <span className="text-sm text-ink-muted">Recorded recurring payments per month</span>
        </div>
        {trendFailed ? (
          <p className="py-10 text-center text-sm text-ink-muted">The spending trend is unavailable right now.</p>
        ) : !trend ? (
          <p className="py-10 text-center text-sm text-ink-muted">Loading spending trend…</p>
        ) : trend.paymentCount === 0 ? (
          <div className="py-10 text-center text-sm text-ink-muted">
            {trend.coverage
              ? 'No recurring payments were detected in your transactions yet.'
              : 'Import transactions to see your recurring spending over time.'}{' '}
            {!trend.coverage && (
              <Link to="/upload" className="font-semibold text-primary hover:text-primary-hover">
                Import a CSV
              </Link>
            )}
          </div>
        ) : (
          <>
            <MonthlySpendChart data={trend.months} variant="area" />
            <p className="mt-2 text-xs text-ink-muted">
              Actual payments from your imported transactions, {trend.months[0]?.label} – {trend.months[trend.months.length - 1]?.label}.{' '}
              <Link to="/analytics" className="font-semibold text-primary hover:text-primary-hover">
                Details
              </Link>
            </p>
          </>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-xl font-semibold text-ink">Upcoming Payments</h2>
          {isLoading ? (
            <div className="py-6 text-center text-sm text-ink-muted">Loading upcoming payments…</div>
          ) : upcoming.length === 0 ? (
            <div className="py-6 text-center text-sm text-ink-muted">No upcoming renewals found.</div>
          ) : (
            <div className="flex flex-col gap-1">
              {upcoming.map((sub) => (
                <div key={sub.id} className="flex items-center justify-between rounded-lg px-2 py-2.5 hover:bg-canvas">
                  <div>
                    <div className="text-sm font-semibold text-ink">{sub.name}</div>
                    <div className="text-xs text-ink-muted">
                      {sub.status === 'potentially_inactive' || sub.status === 'needs_review' ? (
                        <span className="font-medium text-warning">
                          Expected {formatDate(sub.nextBillingDate)} ({sub.daysOverdue ?? '—'}d overdue)
                        </span>
                      ) : (
                        formatDate(sub.nextBillingDate)
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold text-ink">{formatCurrency(sub.amount)}</div>
                    <div className="text-[11px] text-ink-muted capitalize">{sub.billingInterval}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="bg-primary-tint/60">
          <div className="mb-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles size={18} className="text-primary" />
              <h2 className="text-xl font-semibold text-ink">Top Recommendations</h2>
            </div>
            <Link to="/insights" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:text-primary-hover">
              See all <ArrowRight size={14} />
            </Link>
          </div>
          {recsFailed ? (
            <p className="text-sm text-ink-muted">Recommendations are unavailable right now.</p>
          ) : !recs ? (
            <p className="text-sm text-ink-muted">Loading recommendations…</p>
          ) : recs.recommendations.length === 0 ? (
            <p className="text-sm text-ink-muted">
              {recs.hidden.count > 0
                ? `All ${recs.hidden.count} recommendations are in alert categories you've hidden.`
                : recs.summary.subscriptionCount === 0
                  ? 'Import transactions to get personalized recommendations.'
                  : 'Nothing needs your attention right now.'}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {recs.recommendations.slice(0, 3).map((rec) => {
                const { label, icon: Icon } = CATEGORY_META[rec.category]
                return (
                  <Link
                    key={rec.id}
                    to={rec.primarySubscriptionId ? `/subscriptions/${encodeURIComponent(rec.primarySubscriptionId)}` : '/insights'}
                    className="block rounded-lg border border-border bg-surface p-3 hover:shadow-sm"
                  >
                    <div className="flex items-center gap-1.5 text-xs text-ink-muted">
                      <Icon size={13} className="text-primary" /> {label}
                      <span className="ml-auto font-semibold capitalize">{rec.priority.level} priority</span>
                    </div>
                    <div className="mt-1 text-sm font-semibold text-ink">{rec.title}</div>
                    <div className="mt-1">
                      <ImpactLine impact={rec.impact} />
                    </div>
                  </Link>
                )
              })}
              <p className="mt-1 text-[11px] text-ink-muted">
                Ranked by your focus ({recs.meta.focus.replace('_', ' ')}). Rule-based, from your own transactions.
              </p>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
