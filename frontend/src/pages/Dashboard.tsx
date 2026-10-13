import { AlertTriangle, PiggyBank, Repeat, Sparkles, Wallet } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { Card } from '@/components/ui/Card'
import { KpiCard } from '@/components/ui/KpiCard'
import { formatCurrency, formatDate } from '@/lib/format'
import { kpis as fallbackKpis, monthlySpend, subscriptions as fallbackSubscriptions } from '@/lib/mockData'
import { getDashboardKpis, listSubscriptions, type ApiSubscription, type DashboardKpis } from '@/lib/api'
import type { Subscription } from '@/lib/types'

function mapApiSub(apiSub: ApiSubscription): Subscription {
  return {
    id: apiSub.slug || apiSub._id,
    name: apiSub.name,
    category: apiSub.category,
    amount: apiSub.amount,
    previousAmount: apiSub.previousAmount,
    billingInterval: apiSub.billingInterval,
    nextBillingDate: typeof apiSub.nextBillingDate === 'string'
      ? apiSub.nextBillingDate.slice(0, 10)
      : new Date(apiSub.nextBillingDate).toISOString().slice(0, 10),
    status: apiSub.status,
    transactionCount: apiSub.transactionCount,
    confidence: apiSub.confidence,
  }
}

export function Dashboard() {
  const [kpis, setKpis] = useState<DashboardKpis>(fallbackKpis)
  const [subs, setSubs] = useState<Subscription[]>(fallbackSubscriptions)

  useEffect(() => {
    getDashboardKpis()
      .then((res: DashboardKpis) => {
        if (res) setKpis(res)
      })
      .catch(() => {})

    listSubscriptions()
      .then((res: ApiSubscription[]) => {
        if (res && res.length > 0) {
          setSubs(res.map(mapApiSub))
        }
      })
      .catch(() => {})
  }, [])

  const upcoming = [...subs]
    .sort((a, b) => new Date(a.nextBillingDate).getTime() - new Date(b.nextBillingDate).getTime())
    .slice(0, 4)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-bold text-ink">Good morning, Vedant</h1>
        <p className="mt-1 text-base text-ink-muted">
          Here&apos;s what&apos;s happening with your recurring spending.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Monthly recurring spend"
          value={formatCurrency(kpis.monthlySpend)}
          trend={{ value: `${kpis.monthlySpendChangePct}%`, direction: 'up', good: false }}
          caption="vs last month"
          icon={<Wallet size={18} />}
        />
        <KpiCard
          label="Active subscriptions"
          value={String(kpis.activeSubscriptions)}
          caption={`${kpis.newThisMonth} detected this month`}
          icon={<Repeat size={18} />}
        />
        <KpiCard
          label="Potential savings"
          value={formatCurrency(kpis.potentialSavings)}
          caption={`${kpis.flaggedCount} subscriptions flagged`}
          icon={<PiggyBank size={18} />}
        />
        <KpiCard
          label="Alerts"
          value={String(kpis.alertCount)}
          caption={`${kpis.priceIncreaseAlerts} price increases · ${kpis.duplicateAlerts} duplicate`}
          icon={<AlertTriangle size={18} />}
        />
      </div>

      <Card>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-semibold text-ink">Recurring Spend</h2>
          <span className="text-sm text-ink-muted">Last 6 months</span>
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
              <XAxis
                dataKey="month"
                axisLine={false}
                tickLine={false}
                tick={{ fill: '#6b7280', fontSize: 12 }}
              />
              <Tooltip
                formatter={(value) => formatCurrency(Number(value))}
                contentStyle={{ borderRadius: 12, border: '1px solid #E5E7EB', fontSize: 13 }}
              />
              <Area
                type="monotone"
                dataKey="amount"
                stroke="#2563EB"
                strokeWidth={2.5}
                fill="url(#spendGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-xl font-semibold text-ink">Upcoming Payments</h2>
          <div className="flex flex-col gap-1">
            {upcoming.map((sub) => (
              <div
                key={sub.id}
                className="flex items-center justify-between rounded-lg px-2 py-2.5 hover:bg-canvas"
              >
                <div>
                  <div className="text-sm font-semibold text-ink">{sub.name}</div>
                  <div className="text-xs text-ink-muted">{formatDate(sub.nextBillingDate)}</div>
                </div>
                <div className="text-sm font-semibold text-ink">{formatCurrency(sub.amount)}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="bg-primary-tint/60">
          <div className="mb-3 flex items-center gap-2">
            <Sparkles size={18} className="text-primary" />
            <h2 className="text-xl font-semibold text-ink">AI Insight</h2>
          </div>
          <p className="text-sm leading-relaxed text-ink">
            You&apos;re spending <span className="font-semibold">18% more</span> than last month.
            The largest increase came from{' '}
            <span className="font-semibold">Netflix</span> and{' '}
            <span className="font-semibold">Adobe Creative Cloud</span>, which together added{' '}
            {formatCurrency(330)} to your monthly recurring spend.
          </p>
        </Card>
      </div>
    </div>
  )
}
