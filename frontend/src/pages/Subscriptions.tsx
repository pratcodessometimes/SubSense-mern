import { AlertTriangle, Plus, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/format'
import { subscriptions as fallbackSubscriptions } from '@/lib/mockData'
import { listSubscriptions, type ApiSubscription } from '@/lib/api'
import type { Subscription } from '@/lib/types'

function mapApiSubToSubscription(apiSub: ApiSubscription): Subscription {
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
    lastActivity: apiSub.lastActivity
      ? typeof apiSub.lastActivity === 'string'
        ? apiSub.lastActivity.slice(0, 10)
        : new Date(apiSub.lastActivity).toISOString().slice(0, 10)
      : undefined,
  }
}

function statusBadge(sub: Subscription) {
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
  const [data, setData] = useState<Subscription[]>(fallbackSubscriptions)
  const [category, setCategory] = useState('All')
  const [query, setQuery] = useState('')

  useEffect(() => {
    listSubscriptions()
      .then((res) => {
        if (res && res.length > 0) {
          setData(res.map(mapApiSubToSubscription))
        }
      })
      .catch((err) => {
        console.warn('Could not load subscriptions from backend, using fallback data:', err)
      })
  }, [])

  const categories = useMemo(() => {
    return ['All', ...Array.from(new Set(data.map((s) => s.category)))]
  }, [data])

  const filtered = useMemo(() => {
    return data.filter((sub) => {
      const matchesCategory = category === 'All' || sub.category === category
      const matchesQuery = sub.name.toLowerCase().includes(query.toLowerCase())
      return matchesCategory && matchesQuery
    })
  }, [data, category, query])

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[32px] font-bold text-ink">Subscriptions</h1>
          <p className="mt-1 text-base text-ink-muted">
            {data.length} recurring payments detected
          </p>
        </div>
        <Link to="/transactions">
          <Button icon={<Plus size={16} />}>Manage Transactions</Button>
        </Link>
      </div>

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
                    <span className="text-xs font-normal text-ink-muted"> / month</span>
                  </div>
                  <div className="text-xs text-ink-muted">Next: {formatDate(sub.nextBillingDate)}</div>
                </div>
              </div>

              {sub.status === 'price_increase' && (
                <div className="mt-3 flex items-center gap-1.5 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning">
                  <AlertTriangle size={14} className="shrink-0" />
                  Price increased {Math.round(((sub.amount - (sub.previousAmount ?? sub.amount)) / (sub.previousAmount ?? sub.amount)) * 100)}% recently
                </div>
              )}
              {sub.status === 'duplicate' && (
                <div className="mt-3 flex items-center gap-1.5 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning">
                  <AlertTriangle size={14} className="shrink-0" />
                  Potential duplicate subscription detected
                </div>
              )}
              {sub.status === 'unused' && (
                <div className="mt-3 flex items-center gap-1.5 rounded-md bg-danger-tint px-2.5 py-1.5 text-xs font-medium text-danger">
                  <AlertTriangle size={14} className="shrink-0" />
                  Unused: No recent activity detected
                </div>
              )}

              <div className="mt-3">
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-ink-muted">Detection confidence</span>
                  <span className="font-semibold text-ink">{Math.round((sub.confidence || 0.85) * 100)}%</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.round((sub.confidence || 0.85) * 100)}%` }}
                  />
                </div>
              </div>

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
    </div>
  )
}
