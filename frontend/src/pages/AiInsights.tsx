import { EyeOff, Info, Loader2, MessageSquare, RefreshCw, Sparkles, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { clsx } from 'clsx'
import { RecommendationCard } from '@/components/insights/RecommendationCard'
import { FocusSelector } from '@/components/insights/FocusSelector'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { getRecommendations, type RecommendationCategory, type RecommendationsResponse } from '@/lib/api'
import { useAuth } from '@/lib/authContext'
import { formatCurrency } from '@/lib/format'
import { CATEGORY_META } from '@/lib/recommendations'

type PriorityFilter = 'all' | 'high' | 'medium' | 'low'

function Overview({ data }: { data: RecommendationsResponse }) {
  const { summary, recommendations } = data
  const b = summary.savingsBreakdown
  return (
    <Card>
      <h2 className="mb-2 text-xl font-semibold text-ink">Your overview</h2>
      <div className="space-y-2 text-sm leading-relaxed text-ink">
        <p>
          SubSense is tracking <strong>{summary.subscriptionCount}</strong> recurring{' '}
          {summary.subscriptionCount === 1 ? 'payment' : 'payments'} ({summary.activeSubscriptions} currently billing), about{' '}
          <strong>{formatCurrency(summary.monthlyRecurringSpend)}/month</strong> in active recurring spend.
        </p>
        <p>
          {recommendations.length === 0 ? (
            'Nothing needs your attention right now.'
          ) : (
            <>
              <strong>{recommendations.length}</strong> {recommendations.length === 1 ? 'thing deserves' : 'things deserve'} a look
              {summary.byPriority.high > 0 && <> — {summary.byPriority.high} high priority</>}.
            </>
          )}
          {summary.unreviewedCount > 0 && <> {summary.unreviewedCount} detected subscriptions have not been reviewed by you yet.</>}
        </p>
        {summary.potentialSavings > 0 && (
          <p>
            Possible savings estimate: <strong>up to {formatCurrency(summary.potentialSavings)}/month</strong> (strong-evidence duplicate
            charges plus optional consolidation of overlapping services).
          </p>
        )}
        {(b.inactivityReviewAmount ?? 0) > 0 && (
          <p className="text-ink-muted">
            {formatCurrency(b.inactivityReviewAmount ?? 0)}/month belongs to subscriptions with a missing expected payment. It is shown for
            review only and is not counted as a saving.
          </p>
        )}
        {(b.priceIncreaseImpact ?? 0) > 0 && (
          <p className="text-ink-muted">Price increases add {formatCurrency(b.priceIncreaseImpact)}/month to your costs.</p>
        )}
      </div>
    </Card>
  )
}

export function AiInsights() {
  const { user } = useAuth()
  const [attempt, setAttempt] = useState(0)
  const [result, setResult] = useState<{ key: string; data?: RecommendationsResponse; error?: string } | null>(null)
  const [category, setCategory] = useState<RecommendationCategory | 'all'>('all')
  const [priority, setPriority] = useState<PriorityFilter>('all')

  // Re-fetch (re-rank) whenever the saved focus or alert visibility changes, or on retry.
  const requestKey = `${JSON.stringify(user?.preferences)}#${attempt}`
  useEffect(() => {
    let cancelled = false
    getRecommendations()
      .then((data) => !cancelled && setResult({ key: requestKey, data }))
      .catch((err) => !cancelled && setResult({ key: requestKey, error: err instanceof Error ? err.message : 'Could not load recommendations' }))
    return () => {
      cancelled = true
    }
  }, [requestKey])

  // While a re-rank is in flight the previous result stays on screen (with a small spinner).
  const loading = result?.key !== requestKey
  const data = result?.data ?? null
  const error = loading ? null : (result?.error ?? null)
  const load = () => setAttempt((n) => n + 1)

  const categories = useMemo(
    () => Array.from(new Set((data?.recommendations ?? []).map((r) => r.category))),
    [data],
  )
  const filtered = useMemo(
    () =>
      (data?.recommendations ?? []).filter(
        (r) => (category === 'all' || r.category === category) && (priority === 'all' || r.priority.level === priority),
      ),
    [data, category, priority],
  )

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-[28px] font-bold text-ink sm:text-[32px]">AI Insights</h1>
        <p className="mt-1 text-base text-ink-muted">
          Personalized recommendations from your own transactions, ranked by what matters most to you.
        </p>
      </div>

      {loading && !data ? (
        <Card className="flex items-center justify-center gap-2 py-12 text-sm text-ink-muted">
          <Loader2 size={18} className="animate-spin text-primary" /> Analyzing your subscriptions…
        </Card>
      ) : error && !data ? (
        <Card className="flex flex-col items-center gap-3 py-12 text-center">
          <p className="text-sm text-danger">Couldn&apos;t load your insights: {error}</p>
          <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={load}>
            Try again
          </Button>
        </Card>
      ) : data && data.summary.transactionCount === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-12 text-center">
          <Upload size={24} className="text-ink-muted" />
          <p className="text-sm text-ink-muted">Import your transactions and SubSense will build insights from them.</p>
          <Link to="/upload">
            <Button>Import transactions</Button>
          </Link>
        </Card>
      ) : data && data.summary.subscriptionCount === 0 ? (
        <Card className="py-12 text-center text-sm text-ink-muted">
          No recurring subscriptions have been detected in your {data.summary.transactionCount} transactions yet, so there is
          nothing to recommend.
        </Card>
      ) : data ? (
        <>
          <Overview data={data} />

          <Card>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-ink">Ranking focus</h2>
              {loading && <Loader2 size={15} className="animate-spin text-ink-muted" aria-label="Updating" />}
            </div>
            <FocusSelector />
          </Card>

          <div>
            <h2 className="mb-3 text-xl font-semibold text-ink">Recommendations</h2>

            {data.hidden.count > 0 && data.recommendations.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm text-ink-muted">
                <EyeOff size={15} />
                {data.hidden.count} {data.hidden.count === 1 ? 'recommendation is' : 'recommendations are'} hidden by your alert
                visibility settings.
                <Link to="/settings" className="font-semibold text-primary hover:text-primary-hover">
                  Manage
                </Link>
              </div>
            )}

            {data.recommendations.length > 0 && (
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap gap-2">
                  {(['all', ...categories] as const).map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setCategory(c)}
                      className={clsx(
                        'rounded-full px-3 py-1.5 text-xs font-semibold',
                        c === category ? 'bg-primary text-white' : 'border border-border bg-surface text-ink-muted hover:bg-canvas',
                      )}
                    >
                      {c === 'all' ? 'All' : CATEGORY_META[c].label}
                    </button>
                  ))}
                </div>
                <select
                  aria-label="Filter by priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as PriorityFilter)}
                  className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-ink focus:border-primary focus:outline-none"
                >
                  <option value="all">All priorities</option>
                  <option value="high">High priority</option>
                  <option value="medium">Medium priority</option>
                  <option value="low">Low priority</option>
                </select>
              </div>
            )}

            {data.recommendations.length === 0 && data.hidden.count > 0 ? (
              <Card className="flex flex-col items-center gap-3 py-10 text-center">
                <EyeOff size={22} className="text-ink-muted" />
                <p className="text-sm text-ink-muted">
                  All {data.hidden.count} recommendations are in alert categories you&apos;ve hidden. SubSense still tracks them.
                </p>
                <Link to="/settings">
                  <Button variant="secondary">Change alert visibility</Button>
                </Link>
              </Card>
            ) : data.recommendations.length === 0 ? (
              <Card className="py-10 text-center text-sm text-ink-muted">
                No actionable recommendations right now. Your subscriptions show no duplicate charges, price increases, overlaps or
                unusual payments.
              </Card>
            ) : filtered.length === 0 ? (
              <Card className="py-10 text-center text-sm text-ink-muted">No recommendations match these filters.</Card>
            ) : (
              <div className="flex flex-col gap-3">
                {filtered.map((rec) => (
                  <RecommendationCard key={rec.id} rec={rec} rank={data.recommendations.indexOf(rec) + 1} />
                ))}
              </div>
            )}
          </div>
        </>
      ) : null}

      <Card className="bg-primary-tint/40">
        <div className="mb-2 flex items-center gap-2">
          <Info size={17} className="text-primary" />
          <h2 className="text-base font-semibold text-ink">How these insights work</h2>
        </div>
        <p className="text-sm leading-relaxed text-ink-muted">
          Recommendations come from transparent rules applied to your own transactions: recurring-payment detection, price changes,
          duplicate and overlapping charges, missing payments, and a statistical check for payments that differ from your usual
          pattern. They are not predictions from a machine-learning model, and possible savings are estimates you should verify —
          SubSense never cancels anything for you.
        </p>
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-ink-muted">
          <MessageSquare size={16} className="mt-0.5 shrink-0" />
          <span>
            <span className="font-semibold text-ink">Ask SubSense</span> — asking questions in plain language is planned for a future
            update. <Sparkles size={13} className="inline text-primary" />
          </span>
        </div>
      </Card>
    </div>
  )
}
