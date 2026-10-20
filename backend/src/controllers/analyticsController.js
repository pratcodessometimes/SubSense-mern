import { Alert } from '../models/Alert.js'
import { Subscription } from '../models/Subscription.js'
import { Transaction } from '../models/Transaction.js'
import { computeSavingsBreakdown, summarizeRecurringSpend } from '../services/financialImpact.js'
import { buildActualMonthlySeries, buildCategoryBreakdown, buildRecurringProjection } from '../services/monthlyAnalytics.js'
import { ownedBy } from '../utils/ownership.js'

// Phase 4.2: subscriptions the user marked "not a subscription" are excluded from recurring
// totals and savings. Alert display preferences deliberately do NOT affect analytics.
const excludingRejected = (filter) => ({ ...filter, reviewStatus: { $ne: 'not_subscription' } })

export async function getKpis(req, res) {
  const userId = req.user.id
  const [subscriptions, alerts, transactions, transactionCount] = await Promise.all([
    Subscription.find(excludingRejected(ownedBy(userId))),
    Alert.find(ownedBy(userId)),
    Transaction.find(ownedBy(userId, { isRecurring: true })).sort({ date: 1 }),
    Transaction.countDocuments(ownedBy(userId)),
  ])

  // 1-2. Active subscriptions and normalized monthly recurring spend (shared definition, see financialImpact.js)
  const { activeSubscriptions, monthlySpend } = summarizeRecurringSpend(subscriptions)

  // 3. Month-over-month spend trend derived from actual recurring transaction history
  let monthlySpendChangePct = null
  if (transactions.length >= 4) {
    const latestTxTime = new Date(transactions[transactions.length - 1].date).getTime()
    const earliestTxTime = new Date(transactions[0].date).getTime()
    const totalDaySpan = (latestTxTime - earliestTxTime) / (1000 * 60 * 60 * 24)

    if (totalDaySpan >= 35) {
      const window1Start = latestTxTime - 30 * 24 * 60 * 60 * 1000
      const window2Start = latestTxTime - 60 * 24 * 60 * 60 * 1000

      const currentPeriodSpend = transactions
        .filter((t) => new Date(t.date).getTime() >= window1Start)
        .reduce((sum, t) => sum + t.amount, 0)

      const previousPeriodSpend = transactions
        .filter((t) => {
          const time = new Date(t.date).getTime()
          return time >= window2Start && time < window1Start
        })
        .reduce((sum, t) => sum + t.amount, 0)

      if (previousPeriodSpend > 0) {
        monthlySpendChangePct =
          Math.round(((currentPeriodSpend - previousPeriodSpend) / previousPeriodSpend) * 1000) / 10
      }
    }
  }

  // 4. New subscriptions this month derived from first transaction dates
  let newThisMonth = null
  if (subscriptions.length > 0 && transactions.length > 0) {
    const latestTime = new Date(transactions[transactions.length - 1].date).getTime()
    const thirtyDaysAgo = latestTime - 30 * 24 * 60 * 60 * 1000

    const firstSeenMap = new Map()
    for (const t of transactions) {
      const key = t.subscriptionId || t.merchant.toLowerCase().trim()
      if (!firstSeenMap.has(key)) {
        firstSeenMap.set(key, new Date(t.date).getTime())
      }
    }

    const newSubs = subscriptions.filter((s) => {
      const key = s.slug || s.name.toLowerCase().trim()
      const firstSeen = firstSeenMap.get(key) || (s.createdAt ? new Date(s.createdAt).getTime() : null)
      return firstSeen && firstSeen >= thirtyDaysAgo
    })

    newThisMonth = newSubs.length
  }

  // 5. Savings estimate (Phase 4.3 correction). Inactivity amounts, suspected duplicates and price
  //    increases are reported separately and are NOT part of potentialSavings; duplicate exposure is
  //    normalized to a monthly equivalent; a duplicate is never counted again as an overlap.
  const { potentialSavings, breakdown: savingsBreakdown } = computeSavingsBreakdown(subscriptions)

  const flagged = subscriptions.filter(
    (s) =>
      s.status !== 'active' ||
      s.hasDuplicateCharges ||
      (s.overlappingWith && s.overlappingWith.length > 0),
  )

  const priceIncreaseAlerts = alerts.filter((a) => a.type === 'price_increase').length
  const duplicateAlerts = alerts.filter((a) => a.type === 'duplicate' || a.type === 'service_overlap').length
  const inactivityAlerts = alerts.filter(
    (a) => a.type === 'inactivity_review' || a.type === 'unused',
  ).length
  const anomalyAlerts = alerts.filter((a) => a.type === 'payment_anomaly').length

  res.json({
    monthlySpend,
    monthlySpendChangePct,
    activeSubscriptions,
    newThisMonth,
    potentialSavings,
    savingsBreakdown,
    flaggedCount: flagged.length,
    alertCount: alerts.length,
    priceIncreaseAlerts,
    duplicateAlerts,
    inactivityAlerts,
    anomalyAlerts,
    transactionCount,
  })
}

/**
 * GET /api/analytics/categories — normalized monthly recurring spend per category.
 * Phase 5.1 correction: uses the same subscriptions as the monthlySpend KPI (active statuses only;
 * cancelled, inactive and rejected subscriptions are excluded) and the same monthly-equivalent
 * rounding, so the categories add up to the KPI. An account without subscriptions gets [] instead
 * of placeholder categories.
 */
export async function getCategorySpend(req, res) {
  const subscriptions = await Subscription.find(excludingRejected(ownedBy(req.user.id)))
  res.json(buildCategoryBreakdown(subscriptions))
}

function parseMonthsParam(value, { fallback, max }) {
  if (value === undefined) return fallback
  const n = Number(value)
  return typeof value === 'string' && /^\d+$/.test(value) && n >= 1 && n <= max ? n : null
}

/**
 * Phase 5.1 — GET /api/analytics/monthly?months=12&projectionMonths=3
 * The authenticated user's recorded recurring payments per calendar month, their normalized
 * monthly recurring spend, and the recurring charges scheduled for the coming months.
 * See services/monthlyAnalytics.js for exact definitions. Read-only; scoped to req.user.id.
 */
export async function getMonthlyAnalytics(req, res) {
  const months = parseMonthsParam(req.query.months, { fallback: 12, max: 36 })
  const projectionMonths = parseMonthsParam(req.query.projectionMonths, { fallback: 3, max: 12 })
  if (months === null || projectionMonths === null) {
    return res.status(400).json({ error: 'months must be 1-36 and projectionMonths 1-12' })
  }

  const userId = req.user.id
  const [transactions, subscriptions] = await Promise.all([
    Transaction.find(ownedBy(userId)),
    Subscription.find(ownedBy(userId)),
  ])

  const actual = buildActualMonthlySeries({ transactions, subscriptions, months })
  const { activeSubscriptions, monthlySpend } = summarizeRecurringSpend(subscriptions)

  res.json({
    currency: 'INR',
    timezone: 'UTC',
    actual: {
      basis: 'recorded_recurring_payments',
      label: 'Recorded recurring payments',
      description:
        'Payments in your imported or entered transactions that are linked to a detected recurring subscription, ' +
        'summed per calendar month. Subscriptions you marked "not a subscription" are excluded. ' +
        'Months outside your imported data are not shown.',
      ...actual,
    },
    normalized: {
      basis: 'normalized_monthly_recurring',
      label: 'Monthly recurring spend (normalized)',
      description: 'Current amount of each active subscription per month; yearly plans count as 1/12. Not cash flow.',
      monthlySpend,
      activeSubscriptions,
    },
    projection: {
      basis: 'scheduled_recurring_charges',
      label: 'Scheduled recurring charges (estimate)',
      ...buildRecurringProjection({ subscriptions, months: projectionMonths }),
    },
  })
}
