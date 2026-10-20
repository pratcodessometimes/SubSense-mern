/**
 * Monthly analytics (Phase 5.1).
 *
 * Pure functions behind GET /api/analytics/monthly and /api/analytics/categories. They keep three
 * different quantities strictly apart, because mixing them misstates a user's finances:
 *
 *   actual       payments that were actually recorded (imported/entered) and linked to a detected
 *                recurring subscription, summed per calendar month. Historical cash flow.
 *   normalized   the current recurring cost expressed per month (yearly plans / 12). The same
 *                definition as the dashboard "Monthly recurring spend" KPI. Not cash flow.
 *   projection   charges scheduled in the coming months from each active subscription's next
 *                billing date and interval. An estimate of obligations, not a prediction of behaviour.
 *
 * Dates are calendar dates stored as UTC midnight (CSV "2026-08-14" → 2026-08-14T00:00:00Z), so every
 * month boundary here is a UTC calendar month — the same rule the detection engine uses.
 * Currency: INR only. No conversion is performed.
 */
import { isActiveRecurring, isRejected, monthlyEquivalent, round2 } from './financialImpact.js'

const MONTH_LABEL = new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' })
const DAY_MS = 86_400_000

/** 'YYYY-MM' of a date in UTC. */
export const monthKey = (date) => new Date(date).toISOString().slice(0, 7)

function monthStart(key) {
  const [y, m] = key.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1))
}

function addMonths(key, n) {
  const d = monthStart(key)
  d.setUTCMonth(d.getUTCMonth() + n)
  return monthKey(d)
}

export const monthLabel = (key) => MONTH_LABEL.format(monthStart(key))

/** Every month key from `from` to `to` inclusive. */
export function monthRange(from, to) {
  const keys = []
  for (let key = from; key <= to; key = addMonths(key, 1)) keys.push(key)
  return keys
}

/**
 * Recorded recurring payments per calendar month.
 *
 * Counts a transaction only when detection linked it to a recurring subscription (isRecurring) and
 * the user has not rejected that subscription ("not a subscription"). The series covers the months
 * spanned by the user's imported data (first to last transaction of any kind), capped to the most
 * recent `months`. A month inside that span with no recurring payment is reported with amount 0 and
 * paymentCount 0; months outside the imported data are never invented.
 */
export function buildActualMonthlySeries({ transactions, subscriptions, months = 12 }) {
  const rejectedSlugs = new Set((subscriptions || []).filter(isRejected).map((s) => s.slug).filter(Boolean))
  const all = (transactions || []).filter((t) => t?.date && !Number.isNaN(new Date(t.date).getTime()))

  if (all.length === 0) {
    return { months: [], coverage: null, truncated: false, totalAmount: 0, paymentCount: 0 }
  }

  const times = all.map((t) => new Date(t.date).getTime())
  const firstDate = new Date(Math.min(...times))
  const lastDate = new Date(Math.max(...times))
  const firstMonth = monthKey(firstDate)
  const lastMonth = monthKey(lastDate)
  const fullRange = monthRange(firstMonth, lastMonth)
  const range = fullRange.slice(-months)

  const buckets = new Map(range.map((key) => [key, { amount: 0, paymentCount: 0, subscriptions: new Set() }]))
  for (const t of all) {
    if (!t.isRecurring || rejectedSlugs.has(t.subscriptionId)) continue
    const amount = Number(t.amount)
    if (!Number.isFinite(amount) || amount <= 0) continue
    const bucket = buckets.get(monthKey(t.date))
    if (!bucket) continue // older than the displayed window
    bucket.amount += amount
    bucket.paymentCount += 1
    if (t.subscriptionId) bucket.subscriptions.add(t.subscriptionId)
  }

  const series = range.map((key) => {
    const b = buckets.get(key)
    return {
      month: key,
      label: monthLabel(key),
      amount: round2(b.amount),
      paymentCount: b.paymentCount,
      subscriptionCount: b.subscriptions.size,
    }
  })

  return {
    months: series,
    coverage: {
      firstTransactionDate: firstDate.toISOString().slice(0, 10),
      lastTransactionDate: lastDate.toISOString().slice(0, 10),
      firstMonth,
      lastMonth,
      monthsWithData: fullRange.length,
    },
    truncated: fullRange.length > range.length,
    totalAmount: round2(series.reduce((sum, m) => sum + m.amount, 0)),
    paymentCount: series.reduce((sum, m) => sum + m.paymentCount, 0),
  }
}

/** Billing date `k` intervals after `anchor`, keeping the anchor's day of month (clamped to month length), in UTC. */
function nthBillingDate(anchor, interval, k) {
  const y = anchor.getUTCFullYear()
  const m = anchor.getUTCMonth() + (interval === 'yearly' ? 12 * k : k)
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
  return new Date(Date.UTC(y, m, Math.min(anchor.getUTCDate(), daysInMonth)))
}

export const PROJECTION_ASSUMPTIONS = [
  'Includes only subscriptions currently detected as active (including those with a price increase or duplicate-charge flag).',
  'Each subscription is charged its current amount once per billing date; duplicate charges are not projected.',
  'Yearly plans appear only in their renewal month, at the full yearly amount.',
  'Subscriptions you marked "not a subscription", cancelled ones, and ones with missing payments are excluded.',
  'Subscriptions whose expected billing date has passed without a newer recorded payment are excluded until analysis runs again.',
  'This is a schedule of known recurring charges, not a forecast of other spending.',
]

/**
 * Scheduled recurring charges for the current and following months.
 * @param {{ subscriptions: any[], now?: Date, months?: number, staleGraceDays?: number }} options
 */
export function buildRecurringProjection({ subscriptions, now = new Date(), months = 3, staleGraceDays = 7 }) {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const startKey = monthKey(today)
  const keys = monthRange(startKey, addMonths(startKey, months - 1))
  const windowEnd = monthStart(addMonths(startKey, months))
  const buckets = new Map(keys.map((key) => [key, { amount: 0, chargeCount: 0 }]))

  const excluded = { rejected: 0, cancelled: 0, missingPayments: 0, stale: 0 }
  let included = 0

  for (const s of subscriptions || []) {
    if (isRejected(s)) { excluded.rejected++; continue }
    if (s.status === 'confirmed_cancelled') { excluded.cancelled++; continue }
    if (!isActiveRecurring(s)) { excluded.missingPayments++; continue }
    const amount = Number(s.amount)
    const anchor = new Date(s.nextBillingDate)
    if (!Number.isFinite(amount) || amount <= 0 || Number.isNaN(anchor.getTime())) continue
    if (anchor.getTime() < today.getTime() - staleGraceDays * DAY_MS) { excluded.stale++; continue }

    included++
    for (let k = 0; ; k++) {
      const date = nthBillingDate(anchor, s.billingInterval, k)
      if (date >= windowEnd) break
      if (date < today) continue // the billing date is within the grace period, already passed
      const bucket = buckets.get(monthKey(date))
      bucket.amount += amount
      bucket.chargeCount += 1
    }
  }

  return {
    months: keys.map((key, i) => ({
      month: key,
      label: monthLabel(key),
      amount: round2(buckets.get(key).amount),
      chargeCount: buckets.get(key).chargeCount,
      // The current month only counts charges from today onward.
      partial: i === 0,
    })),
    includedSubscriptions: included,
    excluded,
    asOf: today.toISOString().slice(0, 10),
    assumptions: PROJECTION_ASSUMPTIONS,
  }
}

/**
 * Normalized monthly recurring spend by category, using the same subscriptions and the same
 * monthly-equivalent rule as the "Monthly recurring spend" KPI, so the categories add up to it.
 */
export function buildCategoryBreakdown(subscriptions) {
  const byCategory = new Map()
  for (const s of (subscriptions || []).filter(isActiveRecurring)) {
    const monthly = monthlyEquivalent(s.amount, s.billingInterval)
    if (monthly === null) continue
    const category = typeof s.category === 'string' && s.category.trim() ? s.category.trim() : 'Uncategorized'
    const entry = byCategory.get(category) || { category, amount: 0, subscriptionCount: 0 }
    entry.amount += monthly
    entry.subscriptionCount += 1
    byCategory.set(category, entry)
  }
  return [...byCategory.values()]
    .map((e) => ({ ...e, amount: round2(e.amount) }))
    .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category))
}
