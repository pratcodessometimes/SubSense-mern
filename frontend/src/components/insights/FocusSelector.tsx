import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { clsx } from 'clsx'
import { ApiError, type RecommendationFocus } from '@/lib/api'
import { useAuth } from '@/lib/authContext'

const FOCUS_OPTIONS: Array<{ value: RecommendationFocus; label: string; description: string }> = [
  { value: 'balanced', label: 'Balanced', description: 'A mix of financial impact and how urgent a review is' },
  { value: 'reduce_costs', label: 'Reduce costs', description: 'Duplicate charges, overlaps and price increases first' },
  { value: 'billing_risks', label: 'Billing risks', description: 'Duplicate charges and unusual payments first' },
]

/**
 * Saved recommendation focus (Phase 4.3). The selection only changes after the server confirms,
 * so a failed save never looks saved. Used on Settings and on the Insights page.
 */
export function FocusSelector() {
  const { user, updatePreferences } = useAuth()
  const [pending, setPending] = useState<RecommendationFocus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const current = user?.preferences.recommendationFocus ?? 'balanced'

  async function select(value: RecommendationFocus) {
    if (value === current || pending) return
    setPending(value)
    setError(null)
    try {
      await updatePreferences({ recommendationFocus: value })
    } catch (err) {
      setError(`Couldn't save your focus. Your previous choice is still in effect.${err instanceof ApiError ? ` (${err.message})` : ''}`)
    } finally {
      setPending(null)
    }
  }

  return (
    <div>
      <div role="radiogroup" aria-label="Recommendation focus" className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {FOCUS_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={current === o.value}
            disabled={pending !== null}
            onClick={() => select(o.value)}
            className={clsx(
              'rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-wait',
              current === o.value ? 'border-primary bg-primary-tint' : 'border-border bg-surface hover:bg-canvas',
            )}
          >
            <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              {o.label}
              {pending === o.value && <Loader2 size={13} className="animate-spin text-ink-muted" />}
            </span>
            <span className="mt-0.5 block text-xs text-ink-muted">{o.description}</span>
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 rounded-lg bg-danger-tint px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
