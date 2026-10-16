import { Alert } from '../models/Alert.js'
import { Subscription } from '../models/Subscription.js'
import { Transaction } from '../models/Transaction.js'
import { detectServiceOverlaps } from '../services/detectionService.js'

export async function getKpis(req, res) {
  const [subscriptions, alerts, transactions, transactionCount] = await Promise.all([
    Subscription.find(),
    Alert.find(),
    Transaction.find({ isRecurring: true }).sort({ date: 1 }),
    Transaction.countDocuments(),
  ])

  // 1. Active subscriptions (exclude inactive, review-pending, cancelled, or unused)
  const activeSubscriptions = subscriptions.filter(
    (s) =>
      s.status === 'active' ||
      s.status === 'price_increase' ||
      (s.status === 'duplicate' && !['potentially_inactive', 'needs_review', 'confirmed_cancelled'].includes(s.status)),
  )

  // 2. Normalized monthly recurring spend
  const monthlySpend = activeSubscriptions.reduce((sum, s) => {
    const monthlyVal = s.billingInterval === 'yearly' ? Math.round((s.amount / 12) * 100) / 100 : s.amount
    return sum + (monthlyVal || 0)
  }, 0)

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

  // 5. Defensible Multi-Tier Potential Savings Intelligence
  // Tier A: Confirmed duplicate billing exposure
  const confirmedDuplicateSubs = subscriptions.filter(
    (s) => s.hasDuplicateCharges && s.duplicateConfidence !== 'suspected',
  )
  const confirmedSavings = confirmedDuplicateSubs.reduce((sum, s) => {
    const dupAmt = s.duplicateAmount || (s.billingInterval === 'yearly' ? Math.round(s.amount / 12) : s.amount)
    return sum + (dupAmt || 0)
  }, 0)

  // Suspected duplicate billing exposure (separated for transparency)
  const suspectedDuplicateSubs = subscriptions.filter(
    (s) => s.hasDuplicateCharges && s.duplicateConfidence === 'suspected',
  )
  const suspectedDuplicateSavings = suspectedDuplicateSubs.reduce((sum, s) => {
    const dupAmt = s.duplicateAmount || (s.billingInterval === 'yearly' ? Math.round(s.amount / 12) : s.amount)
    return sum + (dupAmt || 0)
  }, 0)

  // Tier B: Conditional service overlap consolidation savings
  const overlaps = detectServiceOverlaps(subscriptions)
  const conditionalSavings = overlaps.reduce((sum, ov) => sum + ov.potentialMonthlySavings, 0)

  // Tier C: Inactive / hiatus subscriptions pending user review
  const inactiveSubs = subscriptions.filter(
    (s) => s.status === 'potentially_inactive' || s.status === 'unused',
  )
  const inactivitySavings = inactiveSubs.reduce((sum, s) => {
    const monthlyVal = s.billingInterval === 'yearly' ? Math.round(s.amount / 12) : s.amount
    return sum + (monthlyVal || 0)
  }, 0)

  // Price increase net monthly budget impact
  const priceIncreaseSubs = subscriptions.filter((s) => s.previousAmount && s.amount > s.previousAmount)
  const priceIncreaseImpact = priceIncreaseSubs.reduce((sum, s) => {
    const isYearly = s.billingInterval === 'yearly'
    const diff = s.monthlyDifference !== undefined
      ? s.monthlyDifference
      : isYearly
        ? Math.round(((s.amount - s.previousAmount) / 12) * 100) / 100
        : s.amount - s.previousAmount
    return sum + diff
  }, 0)

  // Combined defensible savings (avoiding double counting)
  const potentialSavings = Math.round((confirmedSavings + conditionalSavings + inactivitySavings) * 100) / 100

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

  res.json({
    monthlySpend: Math.round(monthlySpend * 100) / 100,
    monthlySpendChangePct,
    activeSubscriptions: activeSubscriptions.length,
    newThisMonth,
    potentialSavings,
    savingsBreakdown: {
      confirmedSavings: Math.round(confirmedSavings * 100) / 100,
      conditionalSavings: Math.round(conditionalSavings * 100) / 100,
      inactivitySavings: Math.round(inactivitySavings * 100) / 100,
      suspectedDuplicateSavings: Math.round(suspectedDuplicateSavings * 100) / 100,
      priceIncreaseImpact: Math.round(priceIncreaseImpact * 100) / 100,
      explanation:
        'Combines confirmed duplicate billing, conditional consolidation savings from overlapping services, and subscriptions pending inactivity review without double-counting.',
    },
    flaggedCount: flagged.length,
    alertCount: alerts.length,
    priceIncreaseAlerts,
    duplicateAlerts,
    inactivityAlerts,
    transactionCount,
  })
}

export async function getCategorySpend(req, res) {
  const subscriptions = await Subscription.find()

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
