import { CalendarClock, Info, Loader2, Upload } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { MonthlySpendChart } from '@/components/analytics/MonthlySpendChart'
import { Card } from '@/components/ui/Card'
import { getCategorySpend, getMonthlyAnalytics, type CategorySpend, type MonthlyAnalytics } from '@/lib/api'
import { formatCurrency } from '@/lib/format'

// Phase 5.1: every figure on this page comes from the signed-in user's own records
// (GET /api/analytics/monthly and /api/analytics/categories). Nothing is sample data.

function formatDay(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-center gap-3 py-10 text-center text-sm text-ink-muted">{children}</div>
}

export function Analytics() {
  const [monthly, setMonthly] = useState<MonthlyAnalytics | null>(null)
  const [categories, setCategories] = useState<CategorySpend[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([getMonthlyAnalytics(12), getCategorySpend()])
      .then(([m, c]) => {
        setMonthly(m)
        setCategories(c)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load analytics'))
  }, [])

  const header = (
    <div>
      <h1 className="text-[28px] font-bold text-ink sm:text-[32px]">Analytics</h1>
      <p className="mt-1 text-base text-ink-muted">Deeper visibility into your recurring spend, from your own transactions.</p>
    </div>
  )

  if (error) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div role="alert" className="rounded-lg border border-danger/30 bg-danger-tint px-4 py-3 text-sm text-danger">
          {error}
        </div>
      </div>
    )
  }

  if (!monthly || !categories) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div className="flex items-center justify-center gap-2 py-16 text-ink-muted">
          <Loader2 size={18} className="animate-spin" /> Loading analytics…
        </div>
      </div>
    )
  }

  const { actual, normalized, projection } = monthly
  const categoryTotal = categories.reduce((sum, c) => sum + c.amount, 0)
  const hasRecurringPayments = actual.paymentCount > 0
  const excludedCount = projection.excluded.cancelled + projection.excluded.missingPayments + projection.excluded.stale

  return (
    <div className="flex flex-col gap-6">
      {header}

      <Card>
        <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold text-ink">Spending over time</h2>
          {hasRecurringPayments && (
            <span className="text-sm text-ink-muted">
              {formatCurrency(actual.totalAmount)} across {actual.paymentCount} payments
            </span>
          )}
        </div>
        <p className="mb-4 text-sm text-ink-muted">
          {actual.label}: actual payments in your transactions that are linked to a detected subscription, by calendar month.
        </p>

        {!actual.coverage ? (
          <EmptyState>
            <span>No transactions yet, so there is no spending history to show.</span>
            <Link to="/upload" className="inline-flex items-center gap-1.5 font-semibold text-primary hover:text-primary-hover">
              <Upload size={14} /> Import a CSV statement
            </Link>
          </EmptyState>
        ) : !hasRecurringPayments ? (
          <EmptyState>
            No recurring payments were detected in your transactions from {formatDay(actual.coverage.firstTransactionDate)} to{' '}
            {formatDay(actual.coverage.lastTransactionDate)}.
          </EmptyState>
        ) : (
          <>
            <MonthlySpendChart data={actual.months} />
            <p className="mt-3 flex items-start gap-1.5 text-xs text-ink-muted">
              <Info size={13} className="mt-0.5 shrink-0" />
              <span>
                Based on transactions dated {formatDay(actual.coverage.firstTransactionDate)} – {formatDay(actual.coverage.lastTransactionDate)}
                {actual.truncated ? `; showing the latest ${actual.months.length} months` : ''}. A month at ₹0 means no recurring
                payment appears in your imported data for that month. Subscriptions you marked “not a subscription” are excluded.
              </span>
            </p>
          </>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-xl font-semibold text-ink">Category breakdown</h2>
            {categoryTotal > 0 && <span className="text-sm font-semibold text-ink">{formatCurrency(normalized.monthlySpend)}/mo</span>}
          </div>
          <p className="mb-4 text-sm text-ink-muted">
            Current monthly cost of your {normalized.activeSubscriptions} active subscription
            {normalized.activeSubscriptions === 1 ? '' : 's'} (yearly plans counted as 1/12). Not a record of payments.
          </p>
          {categories.length === 0 || categoryTotal <= 0 ? (
            <EmptyState>No active subscriptions yet.</EmptyState>
          ) : (
            <ul className="flex flex-col gap-3.5">
              {categories.map((c) => {
                const share = categoryTotal > 0 ? (c.amount / categoryTotal) * 100 : 0
                return (
                  <li key={c.category}>
                    <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate font-medium text-ink">
                        {c.category}{' '}
                        <span className="font-normal text-ink-muted">
                          · {c.subscriptionCount} · {Math.round(share)}%
                        </span>
                      </span>
                      <span className="shrink-0 font-semibold text-ink">{formatCurrency(c.amount)}/mo</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas" aria-hidden="true">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card>
          <div className="mb-1 flex items-center gap-2">
            <CalendarClock size={18} className="text-primary" />
            <h2 className="text-xl font-semibold text-ink">Upcoming recurring charges</h2>
          </div>
          <p className="mb-3 text-sm text-ink-muted">
            Estimate: charges scheduled from each active subscription’s next billing date. Not a forecast of other spending.
          </p>
          {projection.includedSubscriptions === 0 ? (
            <EmptyState>
              No active subscriptions with an upcoming billing date.
              {excludedCount > 0 && ` ${excludedCount} subscription${excludedCount === 1 ? ' is' : 's are'} excluded (cancelled, missing payments or out of date).`}
            </EmptyState>
          ) : (
            <>
              <ul className="flex flex-col">
                {projection.months.map((p) => (
                  <li key={p.month} className="flex items-center justify-between border-b border-border/60 py-2.5 text-sm last:border-0">
                    <span className="text-ink">
                      {p.label}
                      {p.partial && <span className="text-ink-muted"> (rest of month)</span>}
                    </span>
                    <span className="text-right">
                      <span className="font-semibold text-ink">{formatCurrency(p.amount)}</span>
                      <span className="block text-[11px] text-ink-muted">
                        {p.chargeCount} charge{p.chargeCount === 1 ? '' : 's'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <details className="mt-3 text-xs text-ink-muted">
                <summary className="cursor-pointer rounded font-medium text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-tint">
                  How this is estimated
                </summary>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {projection.assumptions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                  <li>
                    Based on {projection.includedSubscriptions} subscription{projection.includedSubscriptions === 1 ? '' : 's'} as of{' '}
                    {formatDay(projection.asOf)}
                    {excludedCount > 0 ? `; ${excludedCount} excluded` : ''}.
                  </li>
                </ul>
              </details>
            </>
          )}
        </Card>
      </div>
    </div>
  )
}
