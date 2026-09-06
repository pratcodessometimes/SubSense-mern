import { AlertTriangle, Loader2, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { UploadTransactionsModal } from '@/components/subscriptions/UploadTransactionsModal'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/format'
import { listAlerts, listSubscriptions, type ApiAlert, type ApiSubscription } from '@/lib/api'

function statusBadge(sub: ApiSubscription) {
  switch (sub.status) {
    case 'price_increase':
      return <Badge tone="warning">Price increased</Badge>
    case 'unused':
      return <Badge tone="critical">Unused</Badge>
    case 'duplicate':
      return <Badge tone="critical">Duplicate</Badge>
    default:
      return <Badge tone="active">Active</Badge>
  }
}

export function Subscriptions() {
  const [subscriptions, setSubscriptions] = useState<ApiSubscription[]>([])
  const [, setAlerts] = useState<ApiAlert[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('')
  const [isUploadModalOpen, setIsUploadModalOpen] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const [subs, alertList] = await Promise.all([listSubscriptions(), listAlerts()])
      setSubscriptions(subs)
      setAlerts(alertList)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load subscriptions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(subscriptions.map((s) => s.category)))],
    [subscriptions],
  )

  const filtered = useMemo(() => {
    return subscriptions.filter((sub) => {
      const matchesCategory = category === 'All' || sub.category === category
      const matchesQuery = sub.name.toLowerCase().includes(query.toLowerCase())
      return matchesCategory && matchesQuery
    })
  }, [subscriptions, category, query])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[32px] font-bold text-ink">Subscriptions</h1>
          <p className="mt-1 text-base text-ink-muted">
            {loading ? 'Loading…' : `${subscriptions.length} recurring payments detected`}
          </p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => setIsUploadModalOpen(true)}>
          Add Transaction
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger-tint px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {!loading && subscriptions.length > 0 && (
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <button
                key={c}
                onClick={() => setCategory(c)}
                className={
                  c === category
                    ? 'rounded-full bg-primary px-3.5 py-1.5 text-sm font-semibold text-white'
                    : 'rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm font-medium text-ink-muted hover:bg-canvas'
                }
              >
                {c}
              </button>
            ))}
          </div>
          <div className="relative w-full sm:w-64">
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              type="text"
              placeholder="Search subscriptions..."
              className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-tint"
            />
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-ink-muted">
          <Loader2 size={18} className="animate-spin" />
          Loading subscriptions…
        </div>
      ) : subscriptions.length === 0 ? (
        <Card className="py-12 text-center text-sm text-ink-muted">
          No subscriptions detected yet. Add a transaction to get started — SubSense needs at least
          two similar payments to recognize a recurring pattern.
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {filtered.map((sub) => (
            <Link key={sub.id} to={`/subscriptions/${sub.id}`}>
              <Card className="h-full transition-shadow hover:shadow-md">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-base font-semibold text-ink">{sub.name}</div>
                    <div className="text-sm text-ink-muted">{sub.category}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-base font-semibold text-ink">
                      {formatCurrency(sub.amount)}
                      <span className="text-xs font-normal text-ink-muted"> / {sub.billingInterval === 'yearly' ? 'year' : 'month'}</span>
                    </div>
                    <div className="text-xs text-ink-muted">Next: {formatDate(sub.nextBillingDate)}</div>
                  </div>
                </div>

                {sub.status === 'price_increase' && (
                  <div className="mt-3 flex items-center gap-1.5 text-xs font-medium text-warning">
                    <AlertTriangle size={13} />
                    Price increased{' '}
                    {Math.round(
                      ((sub.amount - (sub.previousAmount ?? sub.amount)) / (sub.previousAmount ?? sub.amount)) * 100,
                    )}
                    % recently
                  </div>
                )}

                <div className="mt-4 flex items-center justify-between border-t border-border pt-3">
                  <span className="text-xs text-ink-muted">
                    Detected from {sub.transactionCount} transactions
                  </span>
                  {statusBadge(sub)}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}

      {isUploadModalOpen && (
        <UploadTransactionsModal
          onClose={() => setIsUploadModalOpen(false)}
          onComplete={(subs, alertList) => {
            setSubscriptions(subs)
            setAlerts(alertList)
          }}
        />
      )}
    </div>
  )
}
