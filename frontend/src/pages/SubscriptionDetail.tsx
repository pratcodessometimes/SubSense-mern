import { ArrowLeft, Ban, Check, CheckCircle2, TrendingDown, AlertTriangle, Copy, Layers, Clock, Loader2, RotateCcw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ReviewStatusLabel } from '@/components/subscriptions/ReviewStatusLabel'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/format'
import {
  ApiError,
  getSubscription,
  listTransactions,
  reviewSubscription,
  type ApiSubscription,
  type ApiTransaction,
} from '@/lib/api'
import type { ReviewStatus, Subscription } from '@/lib/types'

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
    nextBillingDate:
      typeof apiSub.nextBillingDate === 'string'
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
    reviewStatus: apiSub.reviewStatus ?? 'unreviewed',
    reviewedAt: apiSub.reviewedAt,
  }
}

const REVIEW_COPY: Record<ReviewStatus, string> = {
  unreviewed:
    'SubSense detected this from your transactions. Tell us whether it is a real subscription — your answer is kept every time your data is re-analyzed.',
  confirmed: 'You confirmed this is a subscription. Price, duplicate, inactivity and anomaly checks keep running for it.',
  not_subscription:
    'You marked this as not a subscription. Its payments are kept, but it is left out of your recurring totals and automated alerts.',
}

const REVIEW_SUCCESS: Record<ReviewStatus, string> = {
  confirmed: 'Saved — marked as a subscription.',
  not_subscription: 'Saved — marked as not a subscription.',
  unreviewed: 'Decision reset — automatic detection applies again.',
}

/** Phase 4.2: confirm / reject / reset the user's review decision for this subscription. */
function ReviewCard({ sub, onReviewed }: { sub: Subscription; onReviewed: (next: Subscription) => void }) {
  const [pending, setPending] = useState<ReviewStatus | null>(null)
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)
  const current = sub.reviewStatus ?? 'unreviewed'

  async function apply(next: ReviewStatus) {
    setPending(next)
    setMessage(null)
    try {
      onReviewed(mapApiSubToSubscription(await reviewSubscription(sub.id, next)))
      setMessage({ tone: 'success', text: REVIEW_SUCCESS[next] })
    } catch (err) {
      setMessage({
        tone: 'error',
        text: `Couldn't save your review. Nothing was changed.${err instanceof ApiError ? ` (${err.message})` : ''}`,
      })
    } finally {
      setPending(null)
    }
  }

  const busy = pending !== null
  const spinner = (status: ReviewStatus, icon: ReactNode) =>
    pending === status ? <Loader2 size={16} className="animate-spin" /> : icon

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="text-lg font-semibold text-ink">Your review</h2>
        <div className="flex flex-col items-end gap-0.5">
          <ReviewStatusLabel status={current} className="text-sm" />
          {sub.reviewedAt && current !== 'unreviewed' && (
            <span className="text-[11px] text-ink-muted">on {formatDate(sub.reviewedAt)}</span>
          )}
        </div>
      </div>
      <p className="mt-1 text-sm text-ink-muted">{REVIEW_COPY[current]}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        {current !== 'confirmed' && (
          <Button onClick={() => apply('confirmed')} disabled={busy} icon={spinner('confirmed', <Check size={16} />)}>
            {current === 'not_subscription' ? 'Confirm as subscription' : 'Yes, this is a subscription'}
          </Button>
        )}
        {current !== 'not_subscription' && (
          <Button
            variant="secondary"
            onClick={() => apply('not_subscription')}
            disabled={busy}
            icon={spinner('not_subscription', <Ban size={16} />)}
          >
            Not a subscription
          </Button>
        )}
        {current !== 'unreviewed' && (
          <Button variant="ghost" onClick={() => apply('unreviewed')} disabled={busy} icon={spinner('unreviewed', <RotateCcw size={16} />)}>
            Reset decision
          </Button>
        )}
      </div>

      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`mt-3 rounded-lg px-3 py-2 text-sm ${message.tone === 'error' ? 'bg-danger-tint text-danger' : 'bg-positive-tint text-positive'}`}
        >
          {message.text}
        </p>
      )}
    </Card>
  )
}

export function SubscriptionDetail() {
  const { id } = useParams<{ id: string }>()
  const [sub, setSub] = useState<Subscription | null>(null)
  const [history, setHistory] = useState<Array<{ id: string; date: string; merchant: string; amount: number; account: string; isRecurring: boolean; subscriptionId?: string }>>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    if (!id) return

    setIsLoading(true)
    Promise.all([getSubscription(id), listTransactions()])
      .then(([subRes, txs]) => {
        if (subRes) setSub(mapApiSubToSubscription(subRes))
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

          setHistory(matched)
        }
      })
      .catch((err) => {
        console.error('Failed to load subscription details:', err)
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [id])

  if (isLoading) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <Link to="/subscriptions" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink">
          <ArrowLeft size={15} /> Back to subscriptions
        </Link>
        <Card className="py-12 text-center text-sm text-ink-muted">Loading subscription details…</Card>
      </div>
    )
  }

  if (!sub) {
    return (
      <div className="flex max-w-3xl flex-col gap-4">
        <Link to="/subscriptions" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink">
          <ArrowLeft size={15} /> Back to subscriptions
        </Link>
        <Card className="py-12 text-center text-sm text-ink-muted">
          Subscription &quot;{id}&quot; not found in database.
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

  const isInactivity = sub.status === 'potentially_inactive' || sub.status === 'needs_review' || (sub.daysOverdue !== undefined && sub.daysOverdue > 0)

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
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold text-ink">{sub.name}</h1>
            <p className="mt-1 text-sm text-ink-muted">{sub.category}</p>
          </div>
          <Badge
            tone={
              sub.status === 'active'
                ? 'active'
                : sub.status === 'price_increase'
                  ? 'warning'
                  : sub.status === 'potentially_inactive'
                    ? 'warning'
                    : sub.status === 'needs_review'
                      ? 'neutral'
                      : sub.status === 'duplicate'
                        ? 'critical'
                        : 'neutral'
            }
          >
            {sub.status === 'active'
              ? 'Active'
              : sub.status === 'price_increase'
                ? 'Price increased'
                : sub.status === 'potentially_inactive'
                  ? 'Activity Review'
                  : sub.status === 'needs_review'
                    ? 'Needs Review'
                    : sub.status === 'confirmed_cancelled'
                      ? 'Cancelled'
                      : 'Duplicate'}
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

      <ReviewCard sub={sub} onReviewed={setSub} />

      {/* Inactivity Review Intelligence Card */}
      {isInactivity && (
        <Card className="border-warning/30 bg-warning-tint/20">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Clock className="h-5 w-5 text-warning" />
                <h2 className="text-base font-bold text-ink">Inactivity & Cadence Review Intelligence</h2>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                {sub.inactivityReason || 'Expected recurring payment activity was not detected within the expected billing window.'}
              </p>
            </div>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${
                sub.status === 'needs_review' ? 'bg-primary-tint text-primary' : 'bg-warning-tint text-warning'
              }`}
            >
              {sub.status === 'needs_review' ? 'Cadence Verification' : 'Overdue Review'}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4 border-t border-border/50 pt-3">
            <div>
              <div className="text-xs text-ink-muted">Last Payment</div>
              <div className="text-sm font-semibold text-ink">
                {sub.lastActivity ? formatDate(sub.lastActivity) : 'Recorded'}
              </div>
              {sub.daysSinceLastPayment !== undefined && (
                <div className="text-[11px] text-ink-muted">{sub.daysSinceLastPayment} days ago</div>
              )}
            </div>
            <div>
              <div className="text-xs text-ink-muted">Expected Renewal</div>
              <div className="text-sm font-semibold text-ink">{formatDate(sub.nextBillingDate)}</div>
              {sub.daysOverdue !== undefined && sub.daysOverdue > 0 && (
                <div className="text-[11px] font-medium text-warning">{sub.daysOverdue} days overdue</div>
              )}
            </div>
            <div>
              <div className="text-xs text-ink-muted">Potential at Stake</div>
              <div className="text-sm font-bold text-ink">
                {formatCurrency(sub.amount)} / {sub.billingInterval === 'yearly' ? 'yr' : 'mo'}
              </div>
              <div className="text-[11px] text-ink-muted">Non-guaranteed savings</div>
            </div>
            <div>
              <div className="text-xs text-ink-muted">Evidence Level</div>
              <div className="text-sm font-semibold text-ink">
                {sub.confidence >= 0.85 ? 'High Confidence' : 'Moderate Evidence'}
              </div>
              <div className="text-[11px] text-ink-muted">{sub.transactionCount} payments analyzed</div>
            </div>
          </div>

          {sub.inactivityEvidence && (
            <div className="mt-3 rounded border border-warning/20 bg-surface/70 p-2.5 text-xs text-ink-muted">
              <strong className="text-ink">Detection Evidence: </strong>
              {sub.inactivityEvidence}
            </div>
          )}
        </Card>
      )}

      {/* Price Increase Intelligence Card */}
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
              <div className="text-sm font-semibold text-ink line-through">{formatCurrency(sub.previousAmount)}</div>
            </div>
            <div>
              <div className="text-xs text-ink-muted">Current Price</div>
              <div className="text-sm font-bold text-danger">{formatCurrency(sub.amount)}</div>
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

      {/* Duplicate Charges Intelligence Card */}
      {sub.hasDuplicateCharges && (
        <Card className="border-danger/30 bg-danger-tint/20">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Copy className="h-5 w-5 text-danger" />
                <h2 className="text-base font-bold text-ink">Duplicate Billing Intelligence</h2>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                {sub.duplicateConfidence === 'suspected'
                  ? 'Multiple charges were detected in a short billing cycle. Review to verify whether this is an account upgrade, retry, or duplicate charge.'
                  : 'Multiple recurring charges were confirmed across accounts or repeated billing cycles.'}
              </p>
            </div>
            <span
              className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold ${
                sub.duplicateConfidence === 'suspected'
                  ? 'bg-warning-tint text-warning'
                  : 'bg-danger-tint text-danger'
              }`}
            >
              {sub.duplicateConfidence === 'suspected' ? 'Suspected Duplicate' : 'Confirmed Double Billing'}
            </span>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-border/50 pt-2.5 sm:grid-cols-3 text-xs">
            <div>
              <span className="text-ink-muted">Duplicate Amount:</span>
              <div className="font-bold text-danger">
                {formatCurrency(sub.duplicateAmount || sub.amount)} / {sub.billingInterval === 'yearly' ? 'yr' : 'mo'}
              </div>
            </div>
            <div>
              <span className="text-ink-muted">Confidence Level:</span>
              <div className="font-semibold text-ink">
                {sub.duplicateConfidence === 'suspected' ? 'Suspected Exposure' : 'High Confidence'}
              </div>
            </div>
            {sub.duplicateAccounts && sub.duplicateAccounts.length > 0 && (
              <div className="col-span-2 sm:col-span-1">
                <span className="text-ink-muted">Accounts charged:</span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {sub.duplicateAccounts.map((acc) => (
                    <span
                      key={acc}
                      className="rounded border border-danger/30 bg-danger-tint/60 px-1.5 py-0.5 font-medium text-danger text-[11px]"
                    >
                      {acc}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Service Overlap Intelligence Card */}
      {sub.overlappingWith && sub.overlappingWith.length > 0 && (
        <Card className="border-warning/30 bg-warning-tint/20">
          <div className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Layers className="h-5 w-5 text-warning" />
                <h2 className="text-base font-bold text-ink">Service Overlap Intelligence</h2>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                Compromised budget efficiency: you have multiple active subscriptions in the same functional domain.
              </p>
            </div>
            <span className="inline-flex items-center rounded-full bg-warning-tint px-2.5 py-0.5 text-xs font-bold text-warning">
              Service Overlap
            </span>
          </div>
          <div className="mt-3 border-t border-border/50 pt-2.5 text-xs">
            <span className="text-ink-muted">Overlapping active subscriptions:</span>
            <div className="mt-1 font-semibold text-ink">{sub.overlappingWith.join(', ')}</div>
          </div>
        </Card>
      )}

      {/* Why detected Card */}
      <Card>
        <h2 className="mb-3 text-lg font-semibold text-ink">Why SubSense flagged this</h2>
        <div className="flex flex-col gap-2">
          {reasons.map((r) => (
            <div key={r} className="flex items-center gap-2.5 text-sm text-ink">
              <CheckCircle2 size={16} className="shrink-0 text-positive" />
              <span>{r}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* Transaction History Card */}
      <Card>
        <h2 className="mb-4 text-lg font-semibold text-ink">Payment History</h2>
        {history.length === 0 ? (
          <div className="py-4 text-center text-sm text-ink-muted">No transaction records linked yet.</div>
        ) : (
          <div className="flex flex-col gap-2">
            {history.map((tx) => (
              <div key={tx.id} className="flex items-center justify-between rounded-lg px-2 py-2 hover:bg-canvas">
                <div>
                  <div className="text-sm font-medium text-ink">{formatDate(tx.date)}</div>
                  <div className="text-xs text-ink-muted">{tx.account}</div>
                </div>
                <div className="text-sm font-semibold text-ink">{formatCurrency(tx.amount)}</div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}
