import { Alert } from '../models/Alert.js'
import { Subscription } from '../models/Subscription.js'
import { Transaction } from '../models/Transaction.js'
import { computeSavingsBreakdown, summarizeRecurringSpend } from '../services/financialImpact.js'
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

export async function getCategorySpend(req, res) {
  const subscriptions = await Subscription.find(excludingRejected(ownedBy(req.user.id)))

  if (subscriptions.length === 0) {
    return res.json([
      { category: 'SaaS', amount: 0 },
      { category: 'Streaming', amount: 0 },
      { category: 'Cloud', amount: 0 },
      { category: 'Fitness', amount: 0 },
      { category: 'Software', amount: 0 },
    ])
  }

  const categoryMap = {}
  for (const s of subscriptions) {
    const cat = s.category || 'Other'
    // Normalize yearly amounts to monthly breakdown
    const monthlyVal = s.billingInterval === 'yearly' ? Math.round(s.amount / 12) : s.amount
    categoryMap[cat] = (categoryMap[cat] || 0) + (monthlyVal || 0)
  }

  const result = Object.entries(categoryMap).map(([category, amount]) => ({
    category,
    amount,
  }))

  res.json(result)
}
