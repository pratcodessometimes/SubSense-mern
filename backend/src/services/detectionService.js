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
 * Detects genuine sustained price increases across chronological billing cycles.
 * Distinguishes genuine increases from minor variations (<5%) and temporary spikes.
 *
 * @param {number[]} amounts - Chronological array of payment amounts per billing cycle
 * @param {'monthly' | 'yearly'} [billingInterval='monthly']
 * @param {Date[]} [dates=[]] - Corresponding transaction dates
 * @returns {{
 *   hasPriceIncrease: boolean,
 *   previousAmount?: number,
 *   currentAmount?: number,
 *   priceChangePct?: number,
 *   monthlyDifference?: number,
 *   annualImpact?: number,
 *   priceIncreaseDate?: Date
 * }}
 */
export function detectPriceIncrease(amounts, billingInterval = 'monthly', dates = []) {
  if (!amounts || amounts.length < 2) {
    return { hasPriceIncrease: false }
  }

  const n = amounts.length
  const allIdentical = amounts.every((a) => Math.abs(a - amounts[0]) < 0.01)
  if (allIdentical) {
    return { hasPriceIncrease: false }
  }

  // Check overall variance across all amounts.
  // If entire range variation is < 4%, it is minor fluctuation (e.g. FX jitter or tax)
  const avgAll = amounts.reduce((s, v) => s + v, 0) / n
  const allWithinMinorJitter = amounts.every((v) => Math.abs(v - avgAll) / avgAll < 0.04)
  if (allWithinMinorJitter) {
    return { hasPriceIncrease: false }
  }

  // Evaluate candidate partition points k from n - 1 down to 1.
  // seg2 = amounts[k..n-1] (the latest sustained tier)
  // seg1 = contiguous segment immediately preceding k that is consistent
  // We evaluate from the most recent transition backwards.
  let bestCandidate = null

  for (let k = n - 1; k >= 1; k--) {
    const seg2 = amounts.slice(k)
    const avg2 = seg2.reduce((s, v) => s + v, 0) / seg2.length
    // Suffix consistency (allowing up to 3.5% variation within the new price tier for FX/tax)
    const seg2Consistent = seg2.every((v) => Math.abs(v - avg2) / avg2 <= 0.035)
    if (!seg2Consistent) continue

    // Find the contiguous segment immediately preceding k
    let j = k - 1
    const seg1Candidates = []
    while (j >= 0) {
      seg1Candidates.unshift(amounts[j])
      const avg1Cand = seg1Candidates.reduce((s, v) => s + v, 0) / seg1Candidates.length
      const candConsistent = seg1Candidates.every((v) => Math.abs(v - avg1Cand) / avg1Cand <= 0.035)
      if (!candConsistent) {
        seg1Candidates.shift()
        break
      }
      j--
    }

    if (seg1Candidates.length === 0) continue

    const avg1 = seg1Candidates.reduce((s, v) => s + v, 0) / seg1Candidates.length

    // Genuine price increase requires avg2 > avg1 with at least 5% increase
    if (avg2 > avg1) {
      const changePct = ((avg2 - avg1) / avg1) * 100
      if (changePct >= 5 && changePct <= 250) {
        const prevAmt = Math.round(avg1 * 100) / 100
        const currAmt = Math.round(avg2 * 100) / 100
        const diff = Math.round((currAmt - prevAmt) * 100) / 100

        const monthlyDiff =
          billingInterval === 'yearly'
            ? Math.round((diff / 12) * 100) / 100
            : diff

        const annualImpact =
          billingInterval === 'yearly'
            ? diff
            : Math.round((diff * 12) * 100) / 100

        const increaseDate = dates && dates[k] ? new Date(dates[k]) : undefined

        bestCandidate = {
          hasPriceIncrease: true,
          previousAmount: prevAmt,
          currentAmount: currAmt,
          priceChangePct: Math.round(changePct * 10) / 10,
          monthlyDifference: monthlyDiff,
          annualImpact,
          priceIncreaseDate: increaseDate,
        }
        break
      }
    }
  }

  if (bestCandidate) {
    return bestCandidate
  }

  return { hasPriceIncrease: false }
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
  const cycleDates = cycles.map((t) => t.date)
  const latestAmount = amounts[amounts.length - 1]

  const avgAmount = amounts.reduce((sum, a) => sum + a, 0) / amounts.length
  const amountVariance =
    amounts.length > 1
      ? amounts.reduce((sum, a) => sum + Math.pow(a - avgAmount, 2), 0) / (amounts.length - 1)
      : 0
  const amountStdDev = Math.sqrt(amountVariance)
  const amountCoeffVar = avgAmount > 0 ? amountStdDev / avgAmount : 0

  const allAmountsIdentical = amounts.every((a) => Math.abs(a - latestAmount) < 0.01)

  // Check for genuine price increase using refined intelligence
  const priceAnalysis = detectPriceIncrease(amounts, billingInterval, cycleDates)
  const hasPriceIncrease = priceAnalysis.hasPriceIncrease

  // If amounts vary erratically and no clean price increase, reject
  if (!allAmountsIdentical && !hasPriceIncrease) {
    // Only allow very minor variance (e.g. currency conversion or tax < 4%)
    if (amountCoeffVar > 0.04) {
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
    previousAmount: hasPriceIncrease ? priceAnalysis.previousAmount : undefined,
    priceChangePct: hasPriceIncrease ? priceAnalysis.priceChangePct : undefined,
    monthlyDifference: hasPriceIncrease ? priceAnalysis.monthlyDifference : undefined,
    annualImpact: hasPriceIncrease ? priceAnalysis.annualImpact : undefined,
    priceIncreaseDate: hasPriceIncrease ? priceAnalysis.priceIncreaseDate : undefined,
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
      existing.previousAmount = candidate.previousAmount
      existing.priceChangePct = candidate.priceChangePct
      existing.monthlyDifference = candidate.monthlyDifference
      existing.annualImpact = candidate.annualImpact
      existing.priceIncreaseDate = candidate.priceIncreaseDate
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
        priceChangePct: candidate.priceChangePct,
        monthlyDifference: candidate.monthlyDifference,
        annualImpact: candidate.annualImpact,
        priceIncreaseDate: candidate.priceIncreaseDate,
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
 * Reconciles automated alerts without duplicating records or deleting manual alerts.
 * @param {Array<any>} subscriptions
 */
export async function syncAlertsForSubscriptions(subscriptions) {
  const existingAlerts = await Alert.find()
  const retainedAutomatedIds = new Set()

  // 1. Process Price Increase Alerts
  for (const sub of subscriptions) {
    if (sub.status === 'price_increase' && sub.previousAmount) {
      const diff = Math.round((sub.amount - sub.previousAmount) * 100) / 100
      const isYearly = sub.billingInterval === 'yearly'
      const monthlyDiff =
        sub.monthlyDifference !== undefined
          ? sub.monthlyDifference
          : isYearly
            ? Math.round((diff / 12) * 100) / 100
            : diff
      const annualImpact =
        sub.annualImpact !== undefined
          ? sub.annualImpact
          : isYearly
            ? diff
            : Math.round((diff * 12) * 100) / 100
      const pct =
        sub.priceChangePct !== undefined
          ? sub.priceChangePct
          : Math.round((diff / sub.previousAmount) * 1000) / 10

      const unit = isYearly ? 'year' : 'month'
      const title = `Price increase detected: ${sub.name}`
      const description = `Your ${sub.name} subscription increased from ₹${sub.previousAmount.toLocaleString()} to ₹${sub.amount.toLocaleString()}/${unit} (+${pct}%). Adds ₹${monthlyDiff.toLocaleString()}/month to your budget.`
      const impact = `+₹${annualImpact.toLocaleString()}/yr`
      const impactLabel = 'Annual financial impact'

      // Match existing automated price increase alert for this subscription
      const existing = existingAlerts.find(
        (a) =>
          !a.isManual &&
          a.type === 'price_increase' &&
          (a.subscriptionIds.includes(sub.slug) || (sub._id && a.subscriptionIds.includes(sub._id.toString()))),
      )

      if (existing) {
        const updated = await Alert.findByIdAndUpdate(
          existing._id,
          {
            $set: {
              severity: 'warning',
              title,
              description,
              subscriptionIds: [sub.slug],
              impact,
              impactLabel,
              previousAmount: sub.previousAmount,
              currentAmount: sub.amount,
              percentageChange: pct,
              monthlyImpact: monthlyDiff,
              annualImpact: annualImpact,
            },
          },
          { new: true },
        )
        if (updated) {
          retainedAutomatedIds.add(updated._id.toString())
        }
      } else {
        const created = await Alert.create({
          type: 'price_increase',
          severity: 'warning',
          title,
          description,
          subscriptionIds: [sub.slug],
          impact,
          impactLabel,
          previousAmount: sub.previousAmount,
          currentAmount: sub.amount,
          percentageChange: pct,
          monthlyImpact: monthlyDiff,
          annualImpact,
          isManual: false,
        })
        retainedAutomatedIds.add(created._id.toString())
      }
    }
  }

  // 2. Process Duplicate Alerts
  const categoryMap = {}
  for (const sub of subscriptions) {
    if (!categoryMap[sub.category]) categoryMap[sub.category] = []
    categoryMap[sub.category].push(sub)
  }

  for (const [cat, subs] of Object.entries(categoryMap)) {
    if (subs.length > 1 && ['Cloud', 'Streaming'].includes(cat)) {
      const totalCost = subs.reduce((sum, s) => {
        const m = s.billingInterval === 'yearly' ? Math.round(s.amount / 12) : s.amount
        return sum + m
      }, 0)
      const subSlugs = subs.map((s) => s.slug).sort()

      const existing = existingAlerts.find(
        (a) =>
          !a.isManual &&
          a.type === 'duplicate' &&
          a.subscriptionIds.some((id) => subSlugs.includes(id)),
      )

      const title = `Duplicate ${cat.toLowerCase()} subscriptions detected`
      const description = `You have multiple ${cat} subscriptions (${subs.map((s) => s.name).join(', ')}) with overlapping purpose.`
      const impact = `₹${totalCost.toLocaleString()} / month`
      const impactLabel = 'Potential overlap'

      if (existing) {
        const updated = await Alert.findByIdAndUpdate(
          existing._id,
          {
            $set: {
              severity: 'warning',
              title,
              description,
              subscriptionIds: subSlugs,
              impact,
              impactLabel,
            },
          },
          { new: true },
        )
        if (updated) {
          retainedAutomatedIds.add(updated._id.toString())
        }
      } else {
        const created = await Alert.create({
          type: 'duplicate',
          severity: 'warning',
          title,
          description,
          subscriptionIds: subSlugs,
          impact,
          impactLabel,
          isManual: false,
        })
        retainedAutomatedIds.add(created._id.toString())
      }
    }
  }

  // 3. Process Unused Alerts
  for (const sub of subscriptions) {
    if (sub.status === 'unused') {
      const yearlyCost = sub.billingInterval === 'yearly' ? sub.amount : sub.amount * 12
      const title = `Unused subscription: ${sub.name}`
      const description = `No recent activity detected for ${sub.name}.`
      const impact = `₹${yearlyCost.toLocaleString()}/yr`
      const impactLabel = 'Estimated annual cost'

      const existing = existingAlerts.find(
        (a) =>
          !a.isManual &&
          a.type === 'unused' &&
          (a.subscriptionIds.includes(sub.slug) || (sub._id && a.subscriptionIds.includes(sub._id.toString()))),
      )

      if (existing) {
        const updated = await Alert.findByIdAndUpdate(
          existing._id,
          {
            $set: {
              severity: 'critical',
              title,
              description,
              subscriptionIds: [sub.slug],
              impact,
              impactLabel,
            },
          },
          { new: true },
        )
        if (updated) {
          retainedAutomatedIds.add(updated._id.toString())
        }
      } else {
        const created = await Alert.create({
          type: 'unused',
          severity: 'critical',
          title,
          description,
          subscriptionIds: [sub.slug],
          impact,
          impactLabel,
          isManual: false,
        })
        retainedAutomatedIds.add(created._id.toString())
      }
    }
  }

  // 4. Remove ONLY stale automated alerts that were not retained.
  // Never delete manual alerts!
  const staleAutomatedIds = existingAlerts
    .filter((a) => !a.isManual && !retainedAutomatedIds.has(a._id.toString()))
    .map((a) => a._id)

  if (staleAutomatedIds.length > 0) {
    await Alert.deleteMany({ _id: { $in: staleAutomatedIds }, isManual: { $ne: true } })
  }
}
