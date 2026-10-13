/**
 * Subscription Detection Engine
 * Analyzes transaction series to identify recurring subscription patterns,
 * calculate confidence scores, detect billing intervals and price changes,
 * and link transactions to subscriptions.
 */

import { Alert } from '../models/Alert.js'
import { Subscription } from '../models/Subscription.js'
import { Transaction } from '../models/Transaction.js'
import { normalizeMerchant } from './merchantNormalizer.js'

/**
 * Calculates calendar-aware next billing date.
 * @param {Date} lastDate
 * @param {'monthly' | 'yearly'} interval
 * @param {Date} [referenceDate]
 * @returns {Date}
 */
export function calculateNextBillingDate(lastDate, interval, referenceDate = new Date()) {
  const next = new Date(lastDate)

  if (interval === 'monthly') {
    const originalDay = next.getDate()
    next.setMonth(next.getMonth() + 1)
    // Adjust if month rolled over due to shorter month (e.g. Jan 31 -> Mar 3 -> Feb 28)
    if (next.getDate() !== originalDay) {
      next.setDate(0) // Last day of previous month
    }
  } else {
    next.setFullYear(next.getFullYear() + 1)
  }

  // Roll forward if next date is in the past
  while (next.getTime() < referenceDate.getTime()) {
    if (interval === 'monthly') {
      const day = next.getDate()
      next.setMonth(next.getMonth() + 1)
      if (next.getDate() !== day) next.setDate(0)
    } else {
      next.setFullYear(next.getFullYear() + 1)
    }
  }

  return next
}

/**
 * Analyzes an array of transactions for a single merchant to detect recurrence.
 * @param {Array<{ date: Date, amount: number, account?: string, _id?: any }>} rawTxs
 * @param {string} merchantName
 * @param {string} suggestedCategory
 * @returns {object | null} Detection result or null if not recurring
 */
export function analyzeMerchantRecurrence(rawTxs, merchantName, suggestedCategory) {
  if (!rawTxs || rawTxs.length < 2) {
    return null
  }

  // Sort chronologically ascending
  const sorted = [...rawTxs].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  // Cluster transactions into distinct billing cycles (months or years).
  // This accurately handles statement overlaps, retries, and duplicate charges in the same billing cycle.
  const monthMap = new Map()
  for (const t of sorted) {
    const key = new Date(t.date).toISOString().slice(0, 7) // YYYY-MM
    if (!monthMap.has(key)) monthMap.set(key, [])
    monthMap.get(key).push(t)
  }

  let cycles = []

  if (monthMap.size >= 2) {
    for (const txsInMonth of monthMap.values()) {
      cycles.push(txsInMonth[txsInMonth.length - 1])
    }
  } else {
    // Check yearly (spans across multiple years)
    const yearMap = new Map()
    for (const t of sorted) {
      const yKey = new Date(t.date).getFullYear()
      if (!yearMap.has(yKey)) yearMap.set(yKey, [])
      yearMap.get(yKey).push(t)
    }
    if (yearMap.size >= 2) {
      for (const txsInYear of yearMap.values()) {
        cycles.push(txsInYear[txsInYear.length - 1])
      }
    } else {
      // All transactions in the same calendar month -> insufficient multi-cycle history
      return null
    }
  }

  cycles.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  // Calculate day intervals between consecutive cycles
  const intervals = []
  for (let i = 1; i < cycles.length; i++) {
    const diffMs = new Date(cycles[i].date).getTime() - new Date(cycles[i - 1].date).getTime()
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
    intervals.push(diffDays)
  }

  const avgInterval = intervals.reduce((sum, v) => sum + v, 0) / intervals.length
  const intervalVariance =
    intervals.length > 1
      ? intervals.reduce((sum, v) => sum + Math.pow(v - avgInterval, 2), 0) / (intervals.length - 1)
      : 0
  const intervalStdDev = Math.sqrt(intervalVariance)

  // 1. Determine Billing Interval (Monthly vs Yearly)
  let billingInterval = null

  // Monthly: nominal ~30 days (allowing 24 to 36 days)
  const isMonthly =
    avgInterval >= 24 &&
    avgInterval <= 36 &&
    (intervals.length === 1 || intervalStdDev <= 6.5)

  // Yearly: nominal ~365 days (allowing 340 to 390 days)
  const isYearly =
    avgInterval >= 340 &&
    avgInterval <= 390 &&
    (intervals.length === 1 || intervalStdDev <= 16)

  if (isMonthly) {
    billingInterval = 'monthly'
  } else if (isYearly) {
    billingInterval = 'yearly'
  } else {
    // Irregular intervals -> not a subscription (e.g. coffee, random rides, food)
    return null
  }

  // 2. Amount Analysis across cycles
  const amounts = cycles.map((t) => t.amount)
  const latestAmount = amounts[amounts.length - 1]
  const initialAmount = amounts[0]

  const avgAmount = amounts.reduce((sum, a) => sum + a, 0) / amounts.length
  const amountVariance =
    amounts.length > 1
      ? amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / (amounts.length - 1)
      : 0
  const amountStdDev = Math.sqrt(amountVariance)
  const amountCoeffVar = avgAmount > 0 ? amountStdDev / avgAmount : 0

  const allAmountsIdentical = amounts.every((a) => Math.abs(a - latestAmount) < 0.01)

  // Check for step-change price increase (e.g. [499, 499, 649, 649] or [499, 649])
  let hasPriceIncrease = false
  let previousAmount = undefined

  if (!allAmountsIdentical && amounts.length >= 2) {
    // Partition amounts into two contiguous segments: seg1 = [0..k-1] and seg2 = [k..n-1]
    for (let k = 1; k < amounts.length; k++) {
      const seg1 = amounts.slice(0, k)
      const seg2 = amounts.slice(k)
      const avg1 = seg1.reduce((s, v) => s + v, 0) / seg1.length
      const avg2 = seg2.reduce((s, v) => s + v, 0) / seg2.length

      const seg1Consistent = seg1.every((v) => Math.abs(v - avg1) / avg1 <= 0.03)
      const seg2Consistent = seg2.every((v) => Math.abs(v - avg2) / avg2 <= 0.03)

      if (seg1Consistent && seg2Consistent && avg2 > avg1) {
        const changePct = ((avg2 - avg1) / avg1) * 100
        if (changePct >= 5 && changePct <= 100) {
          hasPriceIncrease = true
          previousAmount = Math.round(avg1)
          break
        }
      }
    }
  }

  // If amounts vary erratically and no clean price increase, reject
  if (!allAmountsIdentical && !hasPriceIncrease) {
    // Only allow very minor variance (e.g. currency conversion or tax < 3%)
    if (amountCoeffVar > 0.03) {
      return null
    }
  }

  // 3. Evidence-Based Confidence Score Calculation (0.0 to 1.0)
  let confidence = 0.45

  // Interval consistency points (up to +0.25)
  if (intervals.length === 1) {
    const targetInterval = billingInterval === 'monthly' ? 30 : 365
    const diffFromTarget = Math.abs(avgInterval - targetInterval)
    if (diffFromTarget <= 2) confidence += 0.22
    else if (diffFromTarget <= 4) confidence += 0.16
    else confidence += 0.10
  } else {
    if (intervalStdDev <= 2.0) confidence += 0.25
    else if (intervalStdDev <= 4.0) confidence += 0.18
    else if (intervalStdDev <= 6.5) confidence += 0.10
  }

  // Amount consistency points (up to +0.20)
  if (allAmountsIdentical) {
    confidence += 0.20
  } else if (hasPriceIncrease) {
    confidence += 0.15
  } else if (amountCoeffVar <= 0.05) {
    confidence += 0.10
  }

  // History depth points (up to +0.10)
  if (sorted.length >= 5) {
    confidence += 0.10
  } else if (sorted.length >= 3) {
    confidence += 0.05
  }

  // Recency points (up to +0.05)
  const lastDate = new Date(sorted[sorted.length - 1].date)
  const daysSinceLast = Math.round((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24))
  const recencyThreshold = billingInterval === 'monthly' ? 45 : 400
  if (daysSinceLast <= recencyThreshold) {
    confidence += 0.05
  }

  // Clamp confidence between 0.10 and 0.98
  confidence = Math.min(0.98, Math.max(0.10, Math.round(confidence * 100) / 100))

  // Must satisfy minimum confidence threshold
  if (confidence < 0.70) {
    return null
  }

  // 4. Status determination
  let status = 'active'
  if (hasPriceIncrease) {
    status = 'price_increase'
  } else if (daysSinceLast > (billingInterval === 'monthly' ? 65 : 450)) {
    status = 'unused'
  }

  const nextBillingDate = calculateNextBillingDate(lastDate, billingInterval)

  return {
    name: merchantName,
    category: suggestedCategory,
    amount: latestAmount,
    previousAmount: hasPriceIncrease ? previousAmount : undefined,
    billingInterval,
    nextBillingDate,
    status,
    transactionCount: sorted.length,
    confidence,
    lastActivity: lastDate,
    transactionIds: sorted.map((t) => t._id).filter(Boolean),
  }
}

/**
 * Runs the detection engine over all transactions in the database (or a given set).
 * Persists detected subscriptions, generates anomaly alerts, and links transactions.
 * Idempotent: repeated runs produce consistent results without duplicating subscriptions.
 * @returns {Promise<{ detectedCount: number, updatedCount: number, subscriptions: any[], alertsCount: number }>}
 */
export async function runSubscriptionDetection() {
  const transactions = await Transaction.find().sort({ date: 1 })

  if (transactions.length === 0) {
    return { detectedCount: 0, updatedCount: 0, subscriptions: [], alertsCount: 0 }
  }

  // 1. Group transactions by normalized merchant canonical key
  const groups = new Map()

  for (const tx of transactions) {
    const { cleanName, canonicalKey, slug, category } = normalizeMerchant(tx.merchant)
    if (!groups.has(canonicalKey)) {
      groups.set(canonicalKey, {
        cleanName,
        canonicalKey,
        slug,
        category,
        transactions: [],
      })
    }
    groups.get(canonicalKey).transactions.push(tx)
  }

  const detectedCandidates = []

  // 2. Analyze each group for recurring patterns
  for (const [canonicalKey, group] of groups.entries()) {
    const result = analyzeMerchantRecurrence(group.transactions, group.cleanName, group.category)
    if (result) {
      detectedCandidates.push({
        ...result,
        slug: group.slug,
        canonicalKey,
      })
    }
  }

  // 3. Check for duplicates across detected candidates within the same category
  const categoryCount = {}
  for (const candidate of detectedCandidates) {
    categoryCount[candidate.category] = (categoryCount[candidate.category] || 0) + 1
  }

  for (const candidate of detectedCandidates) {
    // If multiple subscriptions exist in Cloud or Streaming with similar purpose
    if (categoryCount[candidate.category] > 1 && ['Cloud', 'Streaming'].includes(candidate.category)) {
      if (candidate.status === 'active') {
        candidate.status = 'duplicate'
      }
    }
  }

  // 4. Upsert subscriptions into MongoDB
  let detectedCount = 0
  let updatedCount = 0
  const savedSubscriptions = []

  for (const candidate of detectedCandidates) {
    // Look for existing subscription by slug or name
    let existing = await Subscription.findOne({
      $or: [{ slug: candidate.slug }, { name: { $regex: new RegExp(`^${candidate.name}$`, 'i') } }],
    })

    if (existing) {
      // Reconcile: update detection metrics, preserve manual notes if present
      existing.amount = candidate.amount
      if (candidate.previousAmount) existing.previousAmount = candidate.previousAmount
      existing.billingInterval = candidate.billingInterval
      existing.nextBillingDate = candidate.nextBillingDate
      existing.transactionCount = candidate.transactionCount
      existing.confidence = candidate.confidence
      existing.lastActivity = candidate.lastActivity
      // Update status if not manually locked
      if (!existing.notes?.includes('[manual]')) {
        existing.status = candidate.status
      }
      await existing.save()
      savedSubscriptions.push(existing)
      updatedCount++
    } else {
      // Create new detected subscription
      const created = await Subscription.create({
        slug: candidate.slug,
        name: candidate.name,
        category: candidate.category,
        amount: candidate.amount,
        previousAmount: candidate.previousAmount,
        billingInterval: candidate.billingInterval,
        nextBillingDate: candidate.nextBillingDate,
        status: candidate.status,
        transactionCount: candidate.transactionCount,
        confidence: candidate.confidence,
        lastActivity: candidate.lastActivity,
      })
      savedSubscriptions.push(created)
      detectedCount++
    }
  }

  // 5. Link transactions: Mark matching transactions as recurring & assign subscriptionId
  for (const sub of savedSubscriptions) {
    const matchingTxGroup = groups.get(sub.slug) || Array.from(groups.values()).find((g) => g.cleanName === sub.name)
    if (matchingTxGroup) {
      const txIds = matchingTxGroup.transactions.map((t) => t._id)
      await Transaction.updateMany(
        { _id: { $in: txIds } },
        { $set: { isRecurring: true, subscriptionId: sub.slug } },
      )
    }
  }

  // Mark all transactions that did not match any subscription as isRecurring: false
  const recurringSubSlugs = savedSubscriptions.map((s) => s.slug)
  await Transaction.updateMany(
    { subscriptionId: { $nin: recurringSubSlugs } },
    { $set: { isRecurring: false, subscriptionId: null } },
  )

  // 6. Regenerate Alerts based on active detected subscriptions
  await syncAlertsForSubscriptions(savedSubscriptions)

  const alertCount = await Alert.countDocuments()

  return {
    detectedCount,
    updatedCount,
    totalSubscriptions: savedSubscriptions.length,
    subscriptions: savedSubscriptions,
    alertsCount: alertCount,
  }
}

/**
 * Synchronizes the Alert collection based on detected subscription states.
 * @param {Array<any>} subscriptions
 */
async function syncAlertsForSubscriptions(subscriptions) {
  // Clear automated alerts
  await Alert.deleteMany({})

  const newAlerts = []

  // Check price increases
  for (const sub of subscriptions) {
    if (sub.status === 'price_increase' && sub.previousAmount) {
      const diff = sub.amount - sub.previousAmount
      const yearlyImpact = diff * (sub.billingInterval === 'yearly' ? 1 : 12)
      newAlerts.push({
        type: 'price_increase',
        severity: 'warning',
        title: 'Price increase detected',
        description: `Your ${sub.name} subscription increased by ₹${diff.toLocaleString()}/${sub.billingInterval === 'yearly' ? 'year' : 'month'}.`,
        subscriptionIds: [sub.slug],
        impact: `₹${yearlyImpact.toLocaleString()}`,
        impactLabel: 'Potential yearly impact',
      })
    }
  }

  // Check duplicates
  const categoryMap = {}
  for (const sub of subscriptions) {
    if (!categoryMap[sub.category]) categoryMap[sub.category] = []
    categoryMap[sub.category].push(sub)
  }

  for (const [cat, subs] of Object.entries(categoryMap)) {
    if (subs.length > 1 && ['Cloud', 'Streaming'].includes(cat)) {
      const totalCost = subs.reduce((sum, s) => sum + s.amount, 0)
      newAlerts.push({
        type: 'duplicate',
        severity: 'warning',
        title: `Duplicate ${cat.toLowerCase()} subscriptions detected`,
        description: `You have multiple ${cat} subscriptions (${subs.map((s) => s.name).join(', ')}) with overlapping purpose.`,
        subscriptionIds: subs.map((s) => s.slug),
        impact: `₹${totalCost.toLocaleString()} / month`,
        impactLabel: 'Potential overlap',
      })
    }
  }

  // Check unused
  for (const sub of subscriptions) {
    if (sub.status === 'unused') {
      const yearlyCost = sub.amount * (sub.billingInterval === 'yearly' ? 1 : 12)
      newAlerts.push({
        type: 'unused',
        severity: 'critical',
        title: 'Unused subscription',
        description: `No recent activity detected for ${sub.name}.`,
        subscriptionIds: [sub.slug],
        impact: `₹${yearlyCost.toLocaleString()}`,
        impactLabel: 'Estimated annual cost',
      })
    }
  }

  if (newAlerts.length > 0) {
    await Alert.insertMany(newAlerts)
  }
}
