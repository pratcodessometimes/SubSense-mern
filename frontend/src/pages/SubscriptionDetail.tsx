import { ArrowLeft, CheckCircle2, TrendingDown, AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/format'
import { subscriptions as fallbackSubscriptions, transactions as fallbackTransactions } from '@/lib/mockData'
import { getSubscription, listTransactions, type ApiSubscription, type ApiTransaction } from '@/lib/api'
import type { Subscription } from '@/lib/types'

function mapApiSubToSubscription(apiSub: ApiSubscription): Subscription {
  return {
    id: apiSub.slug || apiSub._id,
    name: apiSub.name,
    category: apiSub.category,
    amount: apiSub.amount,
    previousAmount: apiSub.previousAmount,
    priceChangePct: apiSub.priceChangePct,
    monthlyDifference: apiSub.monthlyDifference,
    annualImpact: apiSub.annualImpact,
    priceIncreaseDate: apiSub.priceIncreaseDate
      ? typeof apiSub.priceIncreaseDate === 'string'
        ? apiSub.priceIncreaseDate.slice(0, 10)
        : new Date(apiSub.priceIncreaseDate).toISOString().slice(0, 10)
      : undefined,
    billingInterval: apiSub.billingInterval,
    nextBillingDate: typeof apiSub.nextBillingDate === 'string'
      ? apiSub.nextBillingDate.slice(0, 10)
      : new Date(apiSub.nextBillingDate).toISOString().slice(0, 10),
    status: apiSub.status,
    transactionCount: apiSub.transactionCount,
    confidence: apiSub.confidence,
    lastActivity: apiSub.lastActivity
      ? typeof apiSub.lastActivity === 'string'
        ? apiSub.lastActivity.slice(0, 10)
        : new Date(apiSub.lastActivity).toISOString().slice(0, 10)
      : undefined,
  }
}

export function SubscriptionDetail() {
  const { id } = useParams<{ id: string }>()
  const fallbackSub = fallbackSubscriptions.find((s) => s.id === id)
  const [sub, setSub] = useState<Subscription | undefined>(fallbackSub)
  const [history, setHistory] = useState(
    fallbackTransactions
      .filter((t) => t.subscriptionId === id)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
  )

  useEffect(() => {
    if (!id) return

    getSubscription(id)
      .then((res) => {
        if (res) setSub(mapApiSubToSubscription(res))
      })
      .catch(() => {
        // Fallback already assigned in initial state
      })

    listTransactions()
      .then((txs) => {
        if (txs && txs.length > 0) {
          const matched = txs
            .filter((t: ApiTransaction) => t.subscriptionId === id || t.merchant.toLowerCase() === id.toLowerCase())
            .map((t: ApiTransaction) => ({
              id: t._id,
              date: t.date,
              merchant: t.merchant,
              amount: t.amount,
              account: t.account,
              isRecurring: t.isRecurring,
              subscriptionId: t.subscriptionId,
            }))
            .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

          if (matched.length > 0) {
            setHistory(matched)
          }
        }
      })
      .catch(() => {})
  }, [id])

  if (!sub) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <Link to="/subscriptions" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink">
          <ArrowLeft size={15} /> Back to subscriptions
        </Link>
        <Card className="py-12 text-center text-sm text-ink-muted">
          Subscription not found.
        </Card>
      </div>
    )
  }

  const reasons = [
    'Same merchant pattern across transactions',
    `${sub.transactionCount} recurring transactions detected`,
    sub.billingInterval === 'yearly' ? '~365 day billing interval' : '~30 day billing interval',
    sub.previousAmount && sub.amount > sub.previousAmount
      ? `Price step increase detected (+${sub.priceChangePct ?? Math.round(((sub.amount - sub.previousAmount) / sub.previousAmount) * 100)}%)`
      : 'Consistent payment amount',
  ]

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Link
        to="/subscriptions"
        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink"
      >
        <ArrowLeft size={15} />
        Back to subscriptions
      </Link>

      <Card>
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold text-ink">{sub.name}</h1>
            <p className="mt-1 text-sm text-ink-muted">{sub.category}</p>
          </div>
          <Badge tone={sub.status === 'active' ? 'active' : sub.status === 'price_increase' ? 'warning' : 'critical'}>
            {sub.status === 'active' ? 'Active' : sub.status === 'price_increase' ? 'Price increased' : sub.status === 'unused' ? 'Unused' : 'Duplicate'}
          </Badge>
        </div>
        <div className="mt-4 text-[28px] font-bold text-ink">
          {formatCurrency(sub.amount)}
          <span className="text-sm font-normal text-ink-muted"> / {sub.billingInterval}</span>
        </div>
        {sub.previousAmount && (
          <div className="mt-1.5 flex items-center gap-1.5 text-sm font-medium text-warning">
            <AlertTriangle size={15} />
            Previous rate: {formatCurrency(sub.previousAmount)} — increased by{' '}
            {sub.priceChangePct ?? Math.round(((sub.amount - sub.previousAmount) / sub.previousAmount) * 100)}%
          </div>
        )}
      </Card>

      {sub.previousAmount && sub.amount > sub.previousAmount && (
        <Card className="border-warning/30 bg-warning-tint/20">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <TrendingDown className="h-5 w-5 text-warning rotate-180" />
                <h2 className="text-base font-bold text-ink">Price Increase Intelligence</h2>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                SubSense detected a price hike in your historical payments
                {sub.priceIncreaseDate ? ` effective around ${formatDate(sub.priceIncreaseDate)}.` : '.'}
              </p>
            </div>
            <span className="inline-flex items-center rounded-full bg-danger-tint px-2.5 py-0.5 text-xs font-bold text-danger">
              +{sub.priceChangePct ?? Math.round(((sub.amount - sub.previousAmount) / sub.previousAmount) * 1000) / 10}%
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 border-t border-border/50 pt-3">
            <div>
              <div className="text-xs text-ink-muted">Previous Price</div>
              <div className="text-sm font-semibold text-ink line-through">
                {formatCurrency(sub.previousAmount)}
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-muted">Current Price</div>
              <div className="text-sm font-bold text-danger">
                {formatCurrency(sub.amount)}
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-muted">Monthly Difference</div>
              <div className="text-sm font-semibold text-ink">
                +{formatCurrency(
                  sub.monthlyDifference ??
                    (sub.billingInterval === 'yearly'
                      ? Math.round(((sub.amount - sub.previousAmount) / 12) * 100) / 100
                      : sub.amount - sub.previousAmount),
                )}
                /mo
              </div>
            </div>
            <div>
              <div className="text-xs text-ink-muted">Annual Impact</div>
              <div className="text-sm font-bold text-danger">
                +{formatCurrency(
                  sub.annualImpact ??
                    (sub.billingInterval === 'yearly'
                      ? sub.amount - sub.previousAmount
                      : (sub.amount - sub.previousAmount) * 12),
                )}
                /yr
              </div>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-xl font-semibold text-ink">Payment history</h2>
        <div className="flex flex-col">
          <div className="grid grid-cols-2 border-b border-border pb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
            <span>Date</span>
            <span className="text-right">Amount</span>
          </div>
          {history.length === 0 ? (
            <div className="py-4 text-center text-xs text-ink-muted">No historical transactions linked yet</div>
          ) : (
            history.map((tx) => (
              <div key={tx.id} className="grid grid-cols-2 border-b border-border/60 py-2.5 text-sm last:border-0">
                <span className="text-ink">{formatDate(tx.date)}</span>
                <span className="text-right font-medium text-ink">{formatCurrency(tx.amount)}</span>
              </div>
            ))
          )}
        </div>
      </Card>

      <Card>
        <h2 className="mb-3 text-xl font-semibold text-ink">Why SubSense detected this</h2>
        <ul className="flex flex-col gap-2.5">
          {reasons.map((reason) => (
            <li key={reason} className="flex items-center gap-2.5 text-sm text-ink">
              <CheckCircle2 size={16} className="shrink-0 text-positive" />
              {reason}
            </li>
          ))}
        </ul>

        <div className="mt-5">
          <div className="mb-1.5 flex items-center justify-between text-sm">
            <span className="font-medium text-ink-muted">Detection confidence</span>
            <span className="font-semibold text-ink">{Math.round(sub.confidence * 100)}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-canvas">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${sub.confidence * 100}%` }}
            />
          </div>
        </div>
      </Card>
    </div>
  )
}
