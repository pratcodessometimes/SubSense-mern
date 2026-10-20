import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/Badge'
import { Card } from '@/components/ui/Card'
import type { Recommendation, RecommendationImpact } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import { CATEGORY_META } from '@/lib/recommendations'

const PRIORITY_BADGE = {
  high: { tone: 'critical', label: 'High priority' },
  medium: { tone: 'warning', label: 'Medium priority' },
  low: { tone: 'neutral', label: 'Low priority' },
} as const

const monthlyYearly = (i: RecommendationImpact, prefix = '') =>
  [
    i.monthly !== undefined ? `${prefix}${formatCurrency(i.monthly)}/mo` : null,
    i.yearly !== undefined ? `${prefix}${formatCurrency(i.yearly)}/yr` : null,
  ]
    .filter(Boolean)
    .join(' · ')

/** Impact text that keeps costs, possible savings and amounts under review clearly apart. */
export function ImpactLine({ impact }: { impact: RecommendationImpact }) {
  let value: string | null = null
  let tone = 'text-ink'
  switch (impact.type) {
    case 'additional_cost':
      value = monthlyYearly(impact, '+')
      tone = 'text-danger'
      break
    case 'potential_duplicate_exposure':
    case 'conditional_savings':
      value = `Up to ${monthlyYearly(impact)}`
      tone = 'text-positive'
      break
    case 'billing_amount_under_review':
      value =
        impact.oneTimeDifference !== undefined
          ? `${impact.oneTimeDifference > 0 ? '+' : '−'}${formatCurrency(Math.abs(impact.oneTimeDifference))} vs usual (one payment)`
          : monthlyYearly(impact)
      tone = 'text-ink-muted'
      break
    default:
      value = null
  }
  return (
    <div className="text-xs">
      <span className="text-ink-muted">{impact.label}</span>
      {value && <span className={`ml-1.5 font-semibold ${tone}`}>{value}</span>}
      {impact.assumption && <div className="mt-0.5 text-[11px] text-ink-muted">{impact.assumption}</div>}
    </div>
  )
}

export function RecommendationCard({ rec, rank, compact = false }: { rec: Recommendation; rank?: number; compact?: boolean }) {
  const { label, icon: Icon } = CATEGORY_META[rec.category]
  const badge = PRIORITY_BADGE[rec.priority.level]
  const subscriptionLink = rec.primarySubscriptionId ? `/subscriptions/${encodeURIComponent(rec.primarySubscriptionId)}` : null

  return (
    <Card className={compact ? 'p-4' : undefined}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary-tint text-primary">
          <Icon size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {rank !== undefined && <span className="text-xs font-bold text-primary/50">#{rank}</span>}
            <span className="text-xs font-medium text-ink-muted">{label}</span>
            <Badge tone={badge.tone}>{badge.label}</Badge>
            <span className="text-[11px] text-ink-muted">· {rec.evidenceLabel}</span>
          </div>
          <h3 className="mt-1 text-base font-semibold text-ink">{rec.title}</h3>
          <p className="mt-0.5 text-sm text-ink-muted">{rec.description}</p>

          <div className="mt-2">
            <ImpactLine impact={rec.impact} />
          </div>

          {!compact && (
            <>
              <p className="mt-3 text-sm leading-relaxed text-ink">{rec.explanation}</p>
              <details className="mt-2 text-xs text-ink-muted">
                <summary className="cursor-pointer font-medium text-ink-muted hover:text-ink">Evidence & ranking</summary>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                  {rec.evidence.map((e) => (
                    <li key={e}>{e}</li>
                  ))}
                </ul>
                <div className="mt-1.5">
                  Priority score {rec.priority.score}:{' '}
                  {rec.priority.factors
                    .map((f) => (f.multiplier !== undefined ? `×${f.multiplier} (${f.detail})` : `${f.points! > 0 ? '+' : ''}${f.points} ${f.detail}`))
                    .join(', ')}
                </div>
              </details>
              <div className="mt-3 rounded-lg bg-canvas px-3 py-2 text-sm">
                <span className="font-semibold text-ink">Next step: {rec.action.label}.</span>{' '}
                <span className="text-ink-muted">{rec.action.detail}</span>
              </div>
            </>
          )}

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm font-semibold">
            {subscriptionLink && (
              <Link to={subscriptionLink} className="inline-flex items-center gap-1 text-primary hover:text-primary-hover">
                {rec.category === 'unreviewed_subscription' ? 'Review subscription' : 'Open subscription'} <ArrowRight size={14} />
              </Link>
            )}
            {rec.sourceAlertIds.length > 0 && (
              <Link to="/alerts" className="inline-flex items-center gap-1 text-ink-muted hover:text-ink">
                View related alert <ArrowRight size={14} />
              </Link>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}
