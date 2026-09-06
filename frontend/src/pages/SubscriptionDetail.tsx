import { ArrowLeft, CheckCircle2 } from 'lucide-react'
import { Link, Navigate, useParams } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/format'
import { subscriptions, transactions } from '@/lib/mockData'

export function SubscriptionDetail() {
  const { id } = useParams()
  const sub = subscriptions.find((s) => s.id === id)

  if (!sub) return <Navigate to="/subscriptions" replace />

  const history = transactions
    .filter((t) => t.subscriptionId === sub.id)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

  const reasons = [
    'Same merchant pattern across transactions',
    `${sub.transactionCount} recurring transactions detected`,
    '~30 day billing interval',
    'Consistent payment amount',
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
          <div className="mt-1 text-sm text-warning">
            Was {formatCurrency(sub.previousAmount)} — increased{' '}
            {Math.round(((sub.amount - sub.previousAmount) / sub.previousAmount) * 100)}%
          </div>
        )}
      </Card>

      <Card>
        <h2 className="mb-3 text-xl font-semibold text-ink">Payment history</h2>
        <div className="flex flex-col">
          <div className="grid grid-cols-2 border-b border-border pb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
            <span>Date</span>
            <span className="text-right">Amount</span>
          </div>
          {history.map((tx) => (
            <div key={tx.id} className="grid grid-cols-2 border-b border-border/60 py-2.5 text-sm last:border-0">
              <span className="text-ink">{formatDate(tx.date)}</span>
              <span className="text-right font-medium text-ink">{formatCurrency(tx.amount)}</span>
            </div>
          ))}
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
