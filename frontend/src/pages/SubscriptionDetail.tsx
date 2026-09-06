import { ArrowLeft, CheckCircle2, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/format'
import { getSubscription, type ApiSubscription } from '@/lib/api'

function reasonsFor(sub: ApiSubscription) {
  const intervalLabel = sub.billingInterval === 'yearly' ? '~365 day' : '~30 day'
  return [
    'Same merchant pattern across transactions',
    `${sub.transactionCount} recurring transactions detected`,
    `${intervalLabel} billing interval`,
    sub.status === 'price_increase' ? 'Amount changed between cycles' : 'Consistent payment amount',
  ]
}

export function SubscriptionDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [sub, setSub] = useState<ApiSubscription | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!id) return
    setLoading(true)
    setError(null)
    getSubscription(id)
      .then(setSub)
      .catch((err) => {
        if (err instanceof Error && err.message.includes('not found')) {
          navigate('/subscriptions', { replace: true })
          return
        }
        setError(err instanceof Error ? err.message : 'Could not load this subscription')
      })
      .finally(() => setLoading(false))
  }, [id, navigate])

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-ink-muted">
        <Loader2 size={18} className="animate-spin" />
        Loading subscription…
      </div>
    )
  }

  if (error || !sub) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <Link to="/subscriptions" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink">
          <ArrowLeft size={15} />
          Back to subscriptions
        </Link>
        <div className="rounded-lg border border-danger/30 bg-danger-tint px-4 py-3 text-sm text-danger">
          {error || 'Subscription not found'}
        </div>
      </div>
    )
  }

  const history = [...sub.history].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  const reasons = reasonsFor(sub)

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
            <div key={tx.date} className="grid grid-cols-2 border-b border-border/60 py-2.5 text-sm last:border-0">
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
