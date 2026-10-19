import { AlertTriangle, Clock, Layers, PiggyBank, Repeat, Sparkles, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { Card } from '@/components/ui/Card'
import { KpiCard } from '@/components/ui/KpiCard'
import { formatCurrency, formatDate } from '@/lib/format'
import { monthlySpend } from '@/lib/mockData'
import { getDashboardKpis, listSubscriptions, type ApiSubscription, type DashboardKpis } from '@/lib/api'
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
        <h1 className="text-[32px] font-bold text-ink">Good morning{firstName ? `, ${firstName}` : ''}</h1>
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
          label="Potential savings"
          value={kpis ? formatCurrency(kpis.potentialSavings) : '—'}
          caption={kpis ? `${kpis.flaggedCount} flagged for review` : 'Analyzing patterns'}
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

      {savings && (savings.confirmedSavings > 0 || savings.conditionalSavings > 0 || savings.inactivitySavings > 0) && (
        <Card className="border-primary/20 bg-primary-tint/20">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <PiggyBank className="h-5 w-5 text-primary" />
                <h3 className="text-sm font-bold text-ink">Defensible Potential Savings Breakdown</h3>
              </div>
              <span className="text-xs text-ink-muted">Non-overlapping financial estimate</span>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 text-xs">
              <div className="rounded-lg border border-border bg-surface p-2.5">
                <div className="flex items-center gap-1.5 font-semibold text-danger">
                  <span className="h-2 w-2 rounded-full bg-danger" />
                  Confirmed Avoidable Charges
                </div>
                <div className="mt-1 text-base font-bold text-ink">{formatCurrency(savings.confirmedSavings)}/mo</div>
                <div className="mt-0.5 text-[11px] text-ink-muted">High-confidence multi-account duplicate billing</div>
              </div>
              <div className="rounded-lg border border-border bg-surface p-2.5">
                <div className="flex items-center gap-1.5 font-semibold text-warning">
                  <Layers size={13} className="text-warning" />
                  Conditional Overlap Savings
                </div>
                <div className="mt-1 text-base font-bold text-ink">{formatCurrency(savings.conditionalSavings)}/mo</div>
                <div className="mt-0.5 text-[11px] text-ink-muted">Potential savings if redundant services are consolidated</div>
              </div>
              <div className="rounded-lg border border-border bg-surface p-2.5">
                <div className="flex items-center gap-1.5 font-semibold text-ink-muted">
                  <Clock size={13} className="text-ink-muted" />
                  Inactivity Review Exposure
                </div>
                <div className="mt-1 text-base font-bold text-ink">{formatCurrency(savings.inactivitySavings)}/mo</div>
                <div className="mt-0.5 text-[11px] text-ink-muted">Estimated amount at stake pending user verification</div>
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-ink">Recurring Spend Trend</h2>
          <span className="text-sm text-ink-muted">Historical monthly volume</span>
        </div>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={monthlySpend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <defs>
                <linearGradient id="spendGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2563EB" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#2563EB" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 12 }} />
              <Tooltip
                formatter={(value) => formatCurrency(Number(value))}
                contentStyle={{ borderRadius: 12, border: '1px solid #E5E7EB', fontSize: 13 }}
              />
              <Area type="monotone" dataKey="amount" stroke="#2563EB" strokeWidth={2.5} fill="url(#spendGradient)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
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
          <div className="mb-3 flex items-center gap-2">
            <Sparkles size={18} className="text-primary" />
            <h2 className="text-xl font-semibold text-ink">Financial Waste Intelligence</h2>
          </div>
          <p className="text-sm leading-relaxed text-ink">
            {kpis?.potentialSavings && kpis.potentialSavings > 0 ? (
              <>
                SubSense identified up to <span className="font-bold text-primary">{formatCurrency(kpis.potentialSavings)}/mo</span>{' '}
                in potential financial optimization across {kpis.flaggedCount} flagged subscriptions. This combines confirmed duplicate charges,
                service consolidation opportunities, and subscriptions with overdue payment activity.
              </>
            ) : (
              <>
                All detected subscriptions are currently operating with consistent cadences and on-schedule billing. No duplicate charges or
                unresolved price increases require attention today.
              </>
            )}
          </p>
          {kpis?.savingsBreakdown?.explanation && (
            <p className="mt-2.5 text-xs text-ink-muted border-t border-border/60 pt-2">
              Calculation policy: {kpis.savingsBreakdown.explanation}
            </p>
          )}
        </Card>
      </div>
    </div>
  )
}
