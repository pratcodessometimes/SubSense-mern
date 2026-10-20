/**
 * Subscription Detection Engine
 * Analyzes transaction series to identify recurring subscription patterns,
 * calculate confidence scores, detect billing intervals and price changes,
 * and link transactions to subscriptions.
 */

import { Alert } from '../models/Alert.js'
import { Subscription } from '../models/Subscription.js'
import { Transaction } from '../models/Transaction.js'
import { normalizeMerchant, SERVICE_DOMAIN_LABELS } from './merchantNormalizer.js'
import { ANOMALY_ALERT_TYPE, runPaymentAnomalyDetection } from './anomalyAlertService.js'
import { escapeRegExp, ownedBy, requireUserId } from '../utils/ownership.js'

/**
 * Calculates the immediate next expected billing date without rolling forward.
 * @param {Date|string} lastDate
 * @param {'monthly' | 'yearly'} interval
 * @returns {Date}
 */
export function getNominalNextBillingDate(lastDate, interval) {
  const next = new Date(lastDate)
  if (interval === 'monthly') {
    const originalDay = next.getDate()
    next.setMonth(next.getMonth() + 1)
    if (next.getDate() !== originalDay) {
      next.setDate(0) // Last day of previous month
    }
  } else {
    next.setFullYear(next.getFullYear() + 1)
  }
  return next
}

/**
 * Calculates calendar-aware next billing date, rolling forward past referenceDate if needed.
 * @param {Date|string} lastDate
 * @param {'monthly' | 'yearly'} interval
 * @param {Date|string} [referenceDate]
 * @returns {Date}
 */
export function calculateNextBillingDate(lastDate, interval, referenceDate = new Date()) {
  const next = getNominalNextBillingDate(lastDate, interval)
  const refTime = new Date(referenceDate).getTime()

  // Roll forward if next date is in the past relative to referenceDate
  while (next.getTime() < refTime) {
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
 * Detects confirmed duplicate charges for a merchant within single billing cycles or across accounts.
 * Supporting evidence includes merchant identity, cycle grouping, inter-charge intervals, account diversity, and amount consistency.
 *
 * @param {Array<{ date: Date, amount: number, account?: string }>} rawTxs
 * @param {'monthly' | 'yearly'} [billingInterval='monthly']
 * @param {number} [expectedAmount=null]
 * @returns {{
 *   hasDuplicateCharges: boolean,
 *   duplicateAccounts: string[],
 *   duplicateAmount: number,
 *   duplicateCyclesCount: number,
 *   proximityPairsCount: number
 * }}
 */
export function detectDuplicateCharges(rawTxs, billingInterval = 'monthly', expectedAmount = null, cycleGroups = null) {
  if (!rawTxs || rawTxs.length < 2) {
    return {
      hasDuplicateCharges: false,
      duplicateAccounts: [],
      duplicateAmount: 0,
      duplicateCyclesCount: 0,
      proximityPairsCount: 0,
    }
  }

  const sorted = [...rawTxs].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
  const refAmount = expectedAmount || sorted[sorted.length - 1].amount

  // Group transactions by billing cycle (month for monthly, year for yearly).
  // Phase 5.1: callers may pass the billing cycles they already derived (proximity clusters for
  // month-end plans, see analyzeMerchantRecurrence) so two consecutive cycles that happen to fall
  // in one calendar month are not mistaken for a duplicate charge.
  const cycleMap = new Map()
  if (cycleGroups) {
    cycleGroups.forEach((group, index) => cycleMap.set(`cycle-${index}`, group))
  } else {
    for (const t of sorted) {
      const key =
        billingInterval === 'yearly'
          ? new Date(t.date).getFullYear().toString()
          : new Date(t.date).toISOString().slice(0, 7) // YYYY-MM
      if (!cycleMap.has(key)) cycleMap.set(key, [])
      cycleMap.get(key).push(t)
    }
  }

  const duplicateCycles = []
  const accountsSet = new Set()
  let totalExtraCharges = 0
  let extraChargesSum = 0

  for (const [cycleKey, txs] of cycleMap.entries()) {
    if (txs.length > 1) {
      // Find charges consistent with the subscription amount (within 15% tolerance)
      const consistentTxs = txs.filter((t) => Math.abs(t.amount - refAmount) / refAmount <= 0.15)
      if (consistentTxs.length > 1) {
        duplicateCycles.push({ cycle: cycleKey, txs: consistentTxs })
        consistentTxs.forEach((t) => {
          if (t.account) accountsSet.add(t.account)
        })
        const extras = consistentTxs.length - 1
        totalExtraCharges += extras
        const sortedInCycle = [...consistentTxs].sort((a, b) => a.amount - b.amount)
        for (let i = 0; i < extras; i++) {
          extraChargesSum += sortedInCycle[i].amount
        }
      }
    }
  }

  // Check for short-interval duplicates (< 20 days for monthly, < 180 days for yearly)
  const proximityThresholdDays = billingInterval === 'yearly' ? 180 : 20
  const proximityPairs = []
  for (let i = 1; i < sorted.length; i++) {
    const diffMs = new Date(sorted[i].date).getTime() - new Date(sorted[i - 1].date).getTime()
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24))
    if (diffDays >= 0 && diffDays <= proximityThresholdDays) {
      const amt1 = sorted[i - 1].amount
      const amt2 = sorted[i].amount
      if (
        Math.abs(amt1 - refAmount) / refAmount <= 0.15 &&
        Math.abs(amt2 - refAmount) / refAmount <= 0.15
      ) {
        proximityPairs.push([sorted[i - 1], sorted[i]])
        if (sorted[i - 1].account) accountsSet.add(sorted[i - 1].account)
        if (sorted[i].account) accountsSet.add(sorted[i].account)
      }
    }
  }

  const hasDuplicateCharges = duplicateCycles.length > 0 || proximityPairs.length > 0

  if (!hasDuplicateCharges) {
    return {
      hasDuplicateCharges: false,
      duplicateAccounts: [],
      duplicateAmount: 0,
      duplicateCyclesCount: 0,
      proximityPairsCount: 0,
      duplicateConfidence: null,
      duplicateSubType: null,
    }
  }

  const duplicateAccounts = Array.from(accountsSet)
  const duplicateAmount =
    totalExtraCharges > 0
      ? Math.round((extraChargesSum / totalExtraCharges) * 100) / 100
      : refAmount

  // Distinguish confirmed vs suspected duplicates:
  // High confidence: Multi-account billing (accountsSet >= 2) OR repeated cycle duplicates (>= 2 cycles)
  // Suspected confidence: Single isolated cycle or single proximity pair without multi-account proof
  const isConfirmed = accountsSet.size >= 2 || duplicateCycles.length >= 2 || (duplicateCycles.length === 1 && totalExtraCharges >= 2)
  const duplicateConfidence = isConfirmed ? 'high' : 'suspected'
  const duplicateSubType = isConfirmed ? 'confirmed_duplicate' : 'suspected_duplicate'

  return {
    hasDuplicateCharges: true,
    duplicateAccounts,
    duplicateAmount,
    duplicateCyclesCount: duplicateCycles.length,
    proximityPairsCount: proximityPairs.length,
    duplicateConfidence,
    duplicateSubType,
  }
}

/**
 * Detects potential service overlaps between different subscriptions providing competing services
 * within the same functional service domain (e.g. video streaming, music streaming, cloud storage).
 * Never triggers purely on broad categories like "Cloud" or "Software".
 *
 * @param {Array<any>} subscriptions
 * @returns {Array<{
 *   serviceDomain: string,
 *   domainLabel: string,
 *   subscriptionIds: string[],
 *   subscriptionNames: string[],
 *   subscriptions: Array<{ id: string, name: string, amount: number, billingInterval: string, monthlyAmount: number, yearlyAmount: number }>,
 *   totalMonthly: number,
 *   totalAnnual: number,
 *   potentialMonthlySavings: number,
 *   potentialAnnualSavings: number
 * }>}
 */
export function detectServiceOverlaps(subscriptions) {
  if (!subscriptions || subscriptions.length < 2) {
    return []
  }

  // Filter for active/price-increase subscriptions that have an assigned serviceDomain
  const eligible = subscriptions.filter(
    // Phase 5.1 (was KNOWN ISSUE 1c): the enum value is 'confirmed_cancelled'; 'cancelled' is kept
    // for any legacy/hand-written records. A cancelled service cannot overlap with anything.
    (s) => s.serviceDomain && s.status !== 'unused' && s.status !== 'cancelled' && s.status !== 'confirmed_cancelled',
  )

  const domainGroups = new Map()
  for (const sub of eligible) {
    const domain = sub.serviceDomain
    if (!domainGroups.has(domain)) {
      domainGroups.set(domain, [])
    }
    domainGroups.get(domain).push(sub)
  }

  const overlaps = []

  for (const [domain, subs] of domainGroups.entries()) {
    // Only flag if 2 or more distinct subscriptions share this specific service domain
    if (subs.length >= 2) {
      const itemized = subs.map((s) => {
        const isYearly = s.billingInterval === 'yearly'
        const monthly = isYearly ? Math.round((s.amount / 12) * 100) / 100 : s.amount
        const yearly = isYearly ? s.amount : Math.round(s.amount * 12 * 100) / 100
        return {
          id: s.slug || s._id?.toString() || s.id || s.name,
          name: s.name,
          amount: s.amount,
          billingInterval: s.billingInterval || 'monthly',
          monthlyAmount: monthly,
          yearlyAmount: yearly,
        }
      })

      const totalMonthly = itemized.reduce((sum, item) => sum + item.monthlyAmount, 0)
      const totalAnnual = itemized.reduce((sum, item) => sum + item.yearlyAmount, 0)

      // Calculate potential savings: sort by monthly cost descending;
      // savings is the cost of all subscriptions except the primary (highest cost) one
      const sortedByCost = [...itemized].sort((a, b) => b.monthlyAmount - a.monthlyAmount)
      const secondaryServices = sortedByCost.slice(1)
      const potentialMonthlySavings = secondaryServices.reduce((sum, item) => sum + item.monthlyAmount, 0)
      const potentialAnnualSavings = secondaryServices.reduce((sum, item) => sum + item.yearlyAmount, 0)

      const domainLabel = SERVICE_DOMAIN_LABELS[domain] || domain.replace(/_/g, ' ')

      overlaps.push({
        serviceDomain: domain,
        domainLabel,
        subscriptionIds: subs.map((s) => s.slug || s._id?.toString() || s.id).sort(),
        subscriptionNames: subs.map((s) => s.name),
        subscriptions: itemized,
        totalMonthly: Math.round(totalMonthly * 100) / 100,
        totalAnnual: Math.round(totalAnnual * 100) / 100,
        potentialMonthlySavings: Math.round(potentialMonthlySavings * 100) / 100,
        potentialAnnualSavings: Math.round(potentialAnnualSavings * 100) / 100,
      })
    }
  }

  return overlaps
}

/**
 * Evaluates subscription activity based on payment history, expected billing date, and grace periods.
 * Deterministic and testable via optional referenceDate.
 *
 * @param {Date|string} lastPaymentDate
 * @param {Date|string} expectedBillingDate
 * @param {'monthly' | 'yearly'} billingInterval
 * @param {number} transactionCount
 * @param {Date|string} [referenceDate]
 * @param {number} [amount=0]
 * @param {string} [manualNotes='']
 * @returns {{
 *   status: 'active' | 'potentially_inactive' | 'needs_review' | 'confirmed_cancelled',
 *   daysSinceLastPayment: number,
 *   daysOverdue: number,
 *   confidenceLabel: 'High Confidence' | 'Moderate Evidence' | 'Preliminary Review' | 'Verified Manual',
 *   inactivityReason: string,
 *   inactivityEvidence: string,
 *   amountAtRisk: number
 * }}
 */
export function evaluateSubscriptionActivity(
  lastPaymentDate,
  expectedBillingDate,
  billingInterval = 'monthly',
  transactionCount = 2,
  referenceDate = null,
  amount = 0,
  manualNotes = '',
  customGracePeriod = null,
) {
  const refDate = referenceDate ? new Date(referenceDate) : new Date()
  const lastDate = new Date(lastPaymentDate)
  const expectedDate = new Date(expectedBillingDate)

  const daysSinceLastPayment = Math.max(0, Math.round((refDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)))
  const daysOverdue = Math.round((refDate.getTime() - expectedDate.getTime()) / (1000 * 60 * 60 * 24))

  // Grace periods: configurable via customGracePeriod or default to 35 days monthly / 85 days yearly
  const gracePeriodDays = customGracePeriod !== null
    ? customGracePeriod
    : (billingInterval === 'yearly' ? 85 : 35)

  // Explicit cancellation override
  if (manualNotes && (manualNotes.includes('[cancelled]') || manualNotes.includes('[confirmed_cancelled]'))) {
    return {
      status: 'confirmed_cancelled',
      daysSinceLastPayment,
      daysOverdue: Math.max(0, daysOverdue),
      confidenceLabel: 'Verified Manual',
      inactivityReason: 'Subscription was manually confirmed as cancelled.',
      inactivityEvidence: 'User marked this subscription as cancelled.',
      amountAtRisk: 0,
    }
  }

  // If not overdue beyond the grace period, subscription is active
  if (daysOverdue <= gracePeriodDays) {
    return {
      status: 'active',
      daysSinceLastPayment,
      daysOverdue: Math.max(0, daysOverdue),
      confidenceLabel: 'High Confidence',
      inactivityReason: 'Payments are current and on schedule.',
      inactivityEvidence: `Last payment recorded on ${lastDate.toISOString().slice(0, 10)} (${daysSinceLastPayment} days ago). Next expected payment is ${expectedDate.toISOString().slice(0, 10)}.`,
      amountAtRisk: 0,
    }
  }

  // If overdue beyond grace period:
  // If transactionCount is low (< 3), cadence is preliminary/uncertain
  if (transactionCount < 3) {
    return {
      status: 'needs_review',
      daysSinceLastPayment,
      daysOverdue,
      confidenceLabel: 'Preliminary Review',
      inactivityReason: 'Expected billing date passed with limited historical payment evidence.',
      inactivityEvidence: `Expected payment on ${expectedDate.toISOString().slice(0, 10)} (${daysOverdue} days past expected date). Only ${transactionCount} recorded payments exist, so cadence requires user review before confirming status.`,
      amountAtRisk: amount,
    }
  }

  // Strong historical cadence exists (>= 3 transactions) and is overdue beyond grace period
  const isMultiCycle = daysOverdue > (billingInterval === 'yearly' ? 60 : 45)
  return {
    status: 'potentially_inactive',
    daysSinceLastPayment,
    daysOverdue,
    confidenceLabel: isMultiCycle ? 'High Confidence' : 'Moderate Evidence',
    inactivityReason: isMultiCycle
      ? 'No billing activity recorded across multiple expected billing cycles.'
      : 'Expected payment was not detected within the expected billing window and grace period.',
    inactivityEvidence: `Last payment recorded on ${lastDate.toISOString().slice(0, 10)} (${daysSinceLastPayment} days ago). Expected next payment on ${expectedDate.toISOString().slice(0, 10)} (${daysOverdue} days overdue). Bank records show missing billing activity; review whether the card expired, subscription was cancelled, or account was moved.`,
    amountAtRisk: amount,
  }
}

/**
 * Analyzes an array of transactions for a single merchant to detect recurrence.
 * @param {Array<{ date: Date, amount: number, account?: string, _id?: any }>} rawTxs
 * @param {string} merchantName
 * @param {string} suggestedCategory
 * @param {Date|string} [referenceDate]
 * @returns {object | null} Detection result or null if not recurring
 */
export function analyzeMerchantRecurrence(rawTxs, merchantName, suggestedCategory, referenceDate = null) {
  if (!rawTxs || rawTxs.length < 2) {
    return null
  }

  const refDate = referenceDate ? new Date(referenceDate) : new Date()

  // Sort chronologically ascending
  const sorted = [...rawTxs].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

  const calendarGroups = calendarCycleGroups(sorted)
  const primary = calendarGroups
    ? evaluateRecurrenceCycles(sorted, calendarGroups, null, merchantName, suggestedCategory, refDate)
    : null
  if (primary) return primary

  // Phase 5.1 (was KNOWN ISSUE 3): calendar-month grouping misses month-end plans whose charge
  // sometimes posts on the 1st of the next month (Jan 30, Mar 1, Mar 30: February looks empty and
  // March looks doubled). Only when the calendar grouping rejects the merchant, retry with billing
  // cycles formed by proximity (charges at most PROXIMITY_CYCLE_GAP_DAYS apart are one cycle) and
  // accept the result only as a monthly subscription. Merchants already detected never reach this
  // path, so existing detections are unchanged.
  const proximityGroups = proximityCycleGroups(sorted)
  if (!proximityGroups || sameCycleGrouping(proximityGroups, calendarGroups)) return null
  const fallback = evaluateRecurrenceCycles(sorted, proximityGroups, proximityGroups, merchantName, suggestedCategory, refDate)
  return fallback && fallback.billingInterval === 'monthly' ? fallback : null
}

/** Retries / same-cycle duplicates post within a few days; consecutive monthly cycles are ~28-31 days apart. */
export const PROXIMITY_CYCLE_GAP_DAYS = 5

/**
 * Original Phase 2 cycle grouping: one group per calendar month (UTC), or per year when every
 * charge falls in one calendar month. Returns null when there is only one cycle.
 */
function calendarCycleGroups(sorted) {
  // Cluster transactions into distinct billing cycles (months or years).
  // This accurately handles statement overlaps, retries, and duplicate charges in the same billing cycle.
  const monthMap = new Map()
  for (const t of sorted) {
    const key = new Date(t.date).toISOString().slice(0, 7) // YYYY-MM
    if (!monthMap.has(key)) monthMap.set(key, [])
    monthMap.get(key).push(t)
  }
  if (monthMap.size >= 2) return [...monthMap.values()]

  // Check yearly (spans across multiple years)
  const yearMap = new Map()
  for (const t of sorted) {
    const yKey = new Date(t.date).getFullYear()
    if (!yearMap.has(yKey)) yearMap.set(yKey, [])
    yearMap.get(yKey).push(t)
  }
  // All transactions in the same calendar month -> insufficient multi-cycle history
  return yearMap.size >= 2 ? [...yearMap.values()] : null
}

/** Groups chronologically sorted charges into cycles: a gap of more than PROXIMITY_CYCLE_GAP_DAYS starts a new cycle. */
function proximityCycleGroups(sorted) {
  const groups = []
  for (const t of sorted) {
    const last = groups[groups.length - 1]
    const prev = last?.[last.length - 1]
    const gapDays = prev ? (new Date(t.date).getTime() - new Date(prev.date).getTime()) / 86_400_000 : Infinity
    if (gapDays <= PROXIMITY_CYCLE_GAP_DAYS) last.push(t)
    else groups.push([t])
  }
  return groups.length >= 2 ? groups : null
}

function sameCycleGrouping(a, b) {
  return Boolean(b) && a.length === b.length && a.every((group, i) => group.length === b[i].length && group.every((t, j) => t === b[i][j]))
}

/**
 * Evaluates one billing-cycle grouping of a merchant's charges (the last charge of each cycle
 * represents that cycle). `duplicateGroups` is passed to detectDuplicateCharges (null = calendar months).
 */
function evaluateRecurrenceCycles(sorted, cycleGroups, duplicateGroups, merchantName, suggestedCategory, refDate) {
  const cycles = cycleGroups.map((group) => group[group.length - 1])
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

  // Evidence-based Duplicate Charges Detection within merchant transactions
  const duplicateAnalysis = detectDuplicateCharges(sorted, billingInterval, latestAmount, duplicateGroups)
  const hasDuplicateCharges = duplicateAnalysis.hasDuplicateCharges

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

  // Recency points relative to refDate (up to +0.05)
  const lastDate = new Date(sorted[sorted.length - 1].date)
  const daysSinceLast = Math.round((refDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24))
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

  // 4. Activity & Status determination
  const nominalNextBillingDate = getNominalNextBillingDate(lastDate, billingInterval)
  const rolledNextBillingDate = calculateNextBillingDate(lastDate, billingInterval, refDate)

  const activityEvaluation = evaluateSubscriptionActivity(
    lastDate,
    nominalNextBillingDate,
    billingInterval,
    sorted.length,
    refDate,
    latestAmount,
  )

  let status = 'active'
  if (hasPriceIncrease) {
    status = 'price_increase'
  } else if (hasDuplicateCharges) {
    status = 'duplicate'
  } else if (activityEvaluation.status === 'potentially_inactive' || activityEvaluation.status === 'needs_review') {
    status = activityEvaluation.status
  }

  // If overdue/inactive, preserve the missed expected billing date for evidence. Otherwise, use next upcoming date.
  const nextBillingDate =
    activityEvaluation.status === 'potentially_inactive' || activityEvaluation.status === 'needs_review'
      ? nominalNextBillingDate
      : rolledNextBillingDate

  return {
    name: merchantName,
    category: suggestedCategory,
    amount: latestAmount,
    previousAmount: hasPriceIncrease ? priceAnalysis.previousAmount : undefined,
    priceChangePct: hasPriceIncrease ? priceAnalysis.priceChangePct : undefined,
    monthlyDifference: hasPriceIncrease ? priceAnalysis.monthlyDifference : undefined,
    annualImpact: hasPriceIncrease ? priceAnalysis.annualImpact : undefined,
    priceIncreaseDate: hasPriceIncrease ? priceAnalysis.priceIncreaseDate : undefined,
    hasDuplicateCharges,
    duplicateAccounts: duplicateAnalysis.duplicateAccounts,
    duplicateAmount: duplicateAnalysis.duplicateAmount,
    duplicateConfidence: duplicateAnalysis.duplicateConfidence,
    duplicateSubType: duplicateAnalysis.duplicateSubType,
    duplicateCyclesCount: duplicateAnalysis.duplicateCyclesCount,
    billingInterval,
    nextBillingDate,
    status,
    transactionCount: sorted.length,
    confidence,
    lastActivity: lastDate,
    daysSinceLastPayment: activityEvaluation.daysSinceLastPayment,
    daysOverdue: activityEvaluation.daysOverdue,
    inactivityReason: activityEvaluation.inactivityReason,
    inactivityEvidence: activityEvaluation.inactivityEvidence,
    confidenceLabel: activityEvaluation.confidenceLabel,
    transactionIds: sorted.map((t) => t._id).filter(Boolean),
  }
}

// Phase 4.1: detection runs for the same user are serialized (per process) so a background
// run triggered by a transaction edit cannot interleave with a manual analysis and race on
// the same subscriptions/alerts. Runs for different users are independent and scoped.
const userDetectionQueues = new Map()

function serializePerUser(userId, task) {
  const previous = userDetectionQueues.get(userId) || Promise.resolve()
  const run = previous.catch(() => {}).then(task)
  const tail = run.catch(() => {})
  userDetectionQueues.set(userId, tail)
  tail.then(() => {
    if (userDetectionQueues.get(userId) === tail) userDetectionQueues.delete(userId)
  })
  return run
}

/**
 * Runs `task` inside the same per-user queue as detection, so it cannot interleave with a
 * detection run for that user (used by the Phase 4.2 review endpoint). Do not call
 * runSubscriptionDetection from inside `task` for the same user: it would wait on itself.
 */
export function runExclusiveForUser(userId, task) {
  return serializePerUser(requireUserId(userId), task)
}

/** Phase 4.2: the user explicitly marked this detection as "not a subscription". */
export function isRejectedByUser(sub) {
  return sub?.reviewStatus === 'not_subscription'
}

/**
 * Fire-and-forget detection for one user (used after transaction create/update/delete).
 * Errors are logged, never thrown into the request that triggered it.
 * @returns {Promise<void>}
 */
export function scheduleSubscriptionDetection(userId, reason = 'background') {
  return runSubscriptionDetection(userId).then(
    () => undefined,
    (err) => console.error(`Detection engine error after ${reason}:`, err.message),
  )
}

/**
 * Runs the detection engine over ONE user's transactions.
 * Persists that user's detected subscriptions, generates their alerts, and links their transactions.
 * Every read and write is scoped by userId; nothing outside the user's records is touched.
 * Idempotent: repeated runs produce consistent results without duplicating subscriptions.
 * @param {string} userId authenticated owner (required; validated)
 * @param {string | Date | null} referenceDate
 * @returns {Promise<{ detectedCount: number, updatedCount: number, subscriptions: any[], alertsCount: number }>}
 */
export function runSubscriptionDetection(userId, referenceDate = null) {
  let ownerId
  try {
    ownerId = requireUserId(userId)
  } catch (err) {
    return Promise.reject(err)
  }
  return serializePerUser(ownerId, () => detectForUser(ownerId, referenceDate))
}

async function detectForUser(userId, referenceDate) {
  const transactions = await Transaction.find(ownedBy(userId)).sort({ date: 1 })

  if (transactions.length === 0) {
    return {
      detectedCount: 0,
      updatedCount: 0,
      subscriptions: [],
      alertsCount: 0,
      anomalyDetection: { status: 'skipped_no_transactions' },
    }
  }

  // 1. Group transactions by normalized merchant canonical key
  const groups = new Map()

  for (const tx of transactions) {
    const { cleanName, canonicalKey, slug, category, serviceDomain } = normalizeMerchant(tx.merchant)
    if (!groups.has(canonicalKey)) {
      groups.set(canonicalKey, {
        cleanName,
        canonicalKey,
        slug,
        category,
        serviceDomain,
        transactions: [],
      })
    }
    groups.get(canonicalKey).transactions.push(tx)
  }

  const detectedCandidates = []

  // 2. Analyze each group for recurring patterns
  for (const [canonicalKey, group] of groups.entries()) {
    const result = analyzeMerchantRecurrence(group.transactions, group.cleanName, group.category, referenceDate)
    if (result) {
      detectedCandidates.push({
        ...result,
        slug: group.slug,
        canonicalKey,
        serviceDomain: group.serviceDomain,
      })
    }
  }

  // 3. Check for service domain overlaps across detected candidates
  const overlaps = detectServiceOverlaps(detectedCandidates)
  const overlapMap = new Map()
  for (const ov of overlaps) {
    for (const item of ov.subscriptions) {
      const others = ov.subscriptionNames.filter((n) => n !== item.name)
      overlapMap.set(item.id, others)
    }
  }

  for (const candidate of detectedCandidates) {
    candidate.overlappingWith = overlapMap.get(candidate.slug) || []
  }

  // 4. Upsert subscriptions into MongoDB
  let detectedCount = 0
  let updatedCount = 0
  const savedSubscriptions = []

  for (const candidate of detectedCandidates) {
    // Look for this user's existing subscription by slug or name.
    // The name comes from merchant text, so it is escaped before use in a RegExp.
    let existing = await Subscription.findOne(ownedBy(userId, {
      $or: [{ slug: candidate.slug }, { name: { $regex: new RegExp(`^${escapeRegExp(candidate.name)}$`, 'i') } }],
    }))

    if (existing) {
      // Reconcile: update detection metrics, preserve manual notes if present
      existing.amount = candidate.amount
      existing.previousAmount = candidate.previousAmount
      existing.priceChangePct = candidate.priceChangePct
      existing.monthlyDifference = candidate.monthlyDifference
      existing.annualImpact = candidate.annualImpact
      existing.priceIncreaseDate = candidate.priceIncreaseDate
      existing.serviceDomain = candidate.serviceDomain
      existing.hasDuplicateCharges = Boolean(candidate.hasDuplicateCharges)
      existing.duplicateAccounts = candidate.duplicateAccounts || []
      existing.duplicateAmount = candidate.duplicateAmount || 0
      existing.duplicateConfidence = candidate.duplicateConfidence || null
      existing.overlappingWith = candidate.overlappingWith || []
      existing.billingInterval = candidate.billingInterval
      existing.nextBillingDate = candidate.nextBillingDate
      existing.transactionCount = candidate.transactionCount
      existing.confidence = candidate.confidence
      existing.lastActivity = candidate.lastActivity
      existing.daysSinceLastPayment = candidate.daysSinceLastPayment
      existing.daysOverdue = candidate.daysOverdue
      existing.inactivityReason = candidate.inactivityReason
      existing.inactivityEvidence = candidate.inactivityEvidence
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
        userId,
        slug: candidate.slug,
        name: candidate.name,
        category: candidate.category,
        serviceDomain: candidate.serviceDomain,
        hasDuplicateCharges: Boolean(candidate.hasDuplicateCharges),
        duplicateAccounts: candidate.duplicateAccounts || [],
        duplicateAmount: candidate.duplicateAmount || 0,
        duplicateConfidence: candidate.duplicateConfidence || null,
        overlappingWith: candidate.overlappingWith || [],
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
        daysSinceLastPayment: candidate.daysSinceLastPayment,
        daysOverdue: candidate.daysOverdue,
        inactivityReason: candidate.inactivityReason,
        inactivityEvidence: candidate.inactivityEvidence,
      })
      savedSubscriptions.push(created)
      detectedCount++
    }
  }

  // 5. Link transactions: Mark matching transactions as recurring & assign subscriptionId.
  //    Phase 4.2: for a subscription the user rejected ("not a subscription") the transactions stay
  //    linked as evidence (so the decision can be reviewed/undone) but are not counted as recurring.
  for (const sub of savedSubscriptions) {
    const matchingTxGroup = groups.get(sub.slug) || Array.from(groups.values()).find((g) => g.cleanName === sub.name)
    if (matchingTxGroup) {
      const txIds = matchingTxGroup.transactions.map((t) => t._id)
      await Transaction.updateMany(
        ownedBy(userId, { _id: { $in: txIds } }),
        { $set: { isRecurring: !isRejectedByUser(sub), subscriptionId: sub.slug } },
      )
    }
  }

  // Mark this user's transactions that did not match any subscription as isRecurring: false.
  // (Before Phase 4.1 this ran globally and would have unlinked every other user's transactions.)
  const recurringSubSlugs = savedSubscriptions.map((s) => s.slug)
  await Transaction.updateMany(
    ownedBy(userId, { subscriptionId: { $nin: recurringSubSlugs } }),
    { $set: { isRecurring: false, subscriptionId: null } },
  )

  // 6. Regenerate this user's alerts based on their detected subscriptions
  await syncAlertsForSubscriptions(userId, savedSubscriptions)

  // 7. Phase 3.3: explainable payment-anomaly alerts for the rule-detected subscriptions.
  //    Never throws; a failure is reported in `anomalyDetection` and leaves the results above intact.
  const transactionsBySlug = new Map()
  for (const sub of savedSubscriptions) {
    const group = groups.get(sub.slug) || Array.from(groups.values()).find((g) => g.cleanName === sub.name)
    transactionsBySlug.set(sub.slug, group ? group.transactions : [])
  }
  const anomalyDetection = await runPaymentAnomalyDetection({
    userId,
    subscriptions: savedSubscriptions,
    transactionsBySlug,
    referenceDate,
    AlertModel: Alert,
  })

  const alertCount = await Alert.countDocuments(ownedBy(userId))

  return {
    detectedCount,
    updatedCount,
    totalSubscriptions: savedSubscriptions.length,
    subscriptions: savedSubscriptions,
    alertsCount: alertCount,
    anomalyDetection,
  }
}

/**
 * Synchronizes ONE user's alerts based on their detected subscription states.
 * Reconciles automated alerts without duplicating records or deleting manual alerts.
 * Supports coexisting alert types for the same subscription (price increase, duplicate, overlap, inactivity).
 * Only alerts owned by `userId` are read, updated, created or deleted.
 * @param {string} userId authenticated owner (required; validated)
 * @param {Array<any>} subscriptions that user's subscriptions
 */
export async function syncAlertsForSubscriptions(userId, allSubscriptions) {
  userId = requireUserId(userId)
  const existingAlerts = await Alert.find(ownedBy(userId))
  // Phase 4.2: subscriptions the user rejected generate no automated alerts and take no part in
  // overlap detection. They still count as *evaluated* (step 4), so their existing automated
  // alerts are reconciled away instead of lingering. Manual alerts are never touched.
  const subscriptions = allSubscriptions.filter((s) => !isRejectedByUser(s))
  const retainedAutomatedIds = new Set()

  // 1. Process Price Increase Alerts (detect even if subscription has additional flags)
  for (const sub of subscriptions) {
    if (sub.previousAmount && sub.priceChangePct && sub.priceChangePct > 0) {
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
        const updated = await Alert.findOneAndUpdate(
          ownedBy(userId, { _id: existing._id }),
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
          userId,
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

  // 2A. Process Duplicate Charges Alerts (differentiating confirmed vs suspected duplicate)
  for (const sub of subscriptions) {
    if (sub.hasDuplicateCharges) {
      const dupAmount = sub.duplicateAmount || sub.amount
      const isYearly = sub.billingInterval === 'yearly'
      const monthlyCost = isYearly ? Math.round((dupAmount / 12) * 100) / 100 : dupAmount
      const annualCost = isYearly ? dupAmount : Math.round(dupAmount * 12 * 100) / 100

      const accountsList = sub.duplicateAccounts && sub.duplicateAccounts.length > 0 ? sub.duplicateAccounts : []
      const isConfirmed =
        sub.duplicateConfidence === 'high' ||
        sub.subType === 'confirmed_duplicate' ||
        accountsList.length >= 2 ||
        (sub.duplicateCyclesCount && sub.duplicateCyclesCount >= 2)
      const subType = isConfirmed ? 'confirmed_duplicate' : 'suspected_duplicate'
      const severity = isConfirmed ? 'critical' : 'warning'
      const confidenceLabel = isConfirmed ? 'High Confidence' : 'Moderate Evidence'

      const accDesc =
        accountsList.length > 1
          ? `across accounts (${accountsList.join(', ')})`
          : accountsList.length === 1
            ? `on account "${accountsList[0]}"`
            : 'in the same billing cycle'

      const title = isConfirmed
        ? `Duplicate charges detected: ${sub.name}`
        : `Suspected duplicate charge: ${sub.name}`

      const description = isConfirmed
        ? `Multiple recurring charges detected for ${sub.name} ${accDesc}. Review your accounts to avoid being charged twice.`
        : `SubSense detected multiple charges for ${sub.name} within a short billing window. Review to verify whether this is an account upgrade, date change, or duplicate billing.`

      const impact = `₹${dupAmount.toLocaleString()} / ${isYearly ? 'year' : 'month'}`
      const impactLabel = isConfirmed ? 'Potential double charge' : 'Suspected duplicate exposure (review recommended)'

      // Match existing automated duplicate alert for this subscription
      const existing = existingAlerts.find(
        (a) =>
          !a.isManual &&
          a.type === 'duplicate' &&
          (a.subscriptionIds.includes(sub.slug) || (sub._id && a.subscriptionIds.includes(sub._id.toString()))),
      )

      if (existing) {
        const updated = await Alert.findOneAndUpdate(
          ownedBy(userId, { _id: existing._id }),
          {
            $set: {
              severity,
              type: 'duplicate',
              subType,
              title,
              description,
              subscriptionIds: [sub.slug],
              duplicateAccounts: accountsList,
              impact,
              impactLabel,
              currentAmount: dupAmount,
              monthlyImpact: monthlyCost,
              annualImpact: annualCost,
              confidenceLabel,
            },
          },
          { new: true },
        )
        if (updated) {
          retainedAutomatedIds.add(updated._id.toString())
        }
      } else {
        const created = await Alert.create({
          userId,
          type: 'duplicate',
          subType,
          severity,
          title,
          description,
          subscriptionIds: [sub.slug],
          duplicateAccounts: accountsList,
          impact,
          impactLabel,
          currentAmount: dupAmount,
          monthlyImpact: monthlyCost,
          annualImpact: annualCost,
          confidenceLabel,
          isManual: false,
        })
        retainedAutomatedIds.add(created._id.toString())
      }
    }
  }

  // 2B. Process Service Overlap Alerts (competing services in the same functional domain)
  const overlaps = detectServiceOverlaps(subscriptions)

  for (const overlap of overlaps) {
    const title = `Overlapping ${overlap.domainLabel} subscriptions: ${overlap.subscriptionNames.join(', ')}`
    const breakdown = overlap.subscriptions
      .map((s) => `${s.name} (₹${s.amount}/${s.billingInterval === 'yearly' ? 'yr' : 'mo'})`)
      .join(', ')
    const description = `You have ${overlap.subscriptionNames.length} active ${overlap.domainLabel} subscriptions (${breakdown}). Review your usage and consider consolidating to save up to ₹${overlap.potentialMonthlySavings.toLocaleString()}/month (₹${overlap.potentialAnnualSavings.toLocaleString()}/yr).`
    const impact = `₹${overlap.totalMonthly.toLocaleString()} / month`
    const impactLabel = `Potential overlap spend (save up to ₹${overlap.potentialMonthlySavings.toLocaleString()}/mo)`

    // Match existing automated service overlap alert for this domain or subscription group
    const existing = existingAlerts.find(
      (a) =>
        !a.isManual &&
        (a.type === 'service_overlap' || a.subType === 'service_overlap' || (a.type === 'duplicate' && a.subType === 'service_overlap')) &&
        (a.serviceDomain === overlap.serviceDomain ||
          (a.subscriptionIds && overlap.subscriptionIds.some((id) => a.subscriptionIds.includes(id)))),
    )

    if (existing) {
      const updated = await Alert.findOneAndUpdate(
        ownedBy(userId, { _id: existing._id }),
        {
          $set: {
            type: 'service_overlap',
            subType: 'service_overlap',
            severity: 'warning',
            title,
            description,
            subscriptionIds: overlap.subscriptionIds,
            serviceDomain: overlap.serviceDomain,
            impact,
            impactLabel,
            monthlyImpact: overlap.potentialMonthlySavings,
            annualImpact: overlap.potentialAnnualSavings,
          },
        },
        { new: true },
      )
      if (updated) {
        retainedAutomatedIds.add(updated._id.toString())
      }
    } else {
      const created = await Alert.create({
        userId,
        type: 'service_overlap',
        subType: 'service_overlap',
        severity: 'warning',
        title,
        description,
        subscriptionIds: overlap.subscriptionIds,
        serviceDomain: overlap.serviceDomain,
        impact,
        impactLabel,
        monthlyImpact: overlap.potentialMonthlySavings,
        annualImpact: overlap.potentialAnnualSavings,
        isManual: false,
      })
      retainedAutomatedIds.add(created._id.toString())
    }
  }

  // 3. Process Inactivity Review Alerts
  for (const sub of subscriptions) {
    if (sub.status === 'potentially_inactive' || sub.status === 'needs_review' || sub.status === 'unused') {
      const isYearly = sub.billingInterval === 'yearly'
      const periodUnit = isYearly ? 'year' : 'month'
      const isPotentiallyInactive = sub.status === 'potentially_inactive' || sub.status === 'unused'
      const subType = isPotentiallyInactive ? 'potentially_inactive' : 'needs_review'
      const severity = isPotentiallyInactive ? 'warning' : 'info'
      const confidenceLabel = sub.confidenceLabel || (sub.confidence >= 0.85 ? 'High Confidence' : 'Moderate Evidence')

      const lastPaidFormatted = sub.lastActivity
        ? new Date(sub.lastActivity).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'recorded date'
      const expectedFormatted = sub.nextBillingDate
        ? new Date(sub.nextBillingDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
        : 'expected date'

      const title = isPotentiallyInactive
        ? `Subscription activity review: ${sub.name}`
        : `Cadence verification needed: ${sub.name}`

      const description = isPotentiallyInactive
        ? `No recurring billing detected for ${sub.name} since ${lastPaidFormatted}. Expected payment was on ${expectedFormatted} (${sub.daysOverdue || 'several'} days overdue). Verify if this subscription was cancelled, switched cards, or paused.`
        : `Billing cadence for ${sub.name} requires user review. Expected payment on ${expectedFormatted} was not detected. With limited payment history, please verify if this subscription is still active.`

      const impact = `₹${sub.amount.toLocaleString()} / ${periodUnit}`
      const impactLabel = isPotentiallyInactive ? 'Potential savings if discontinued' : 'Subscription amount under review'

      // Match existing automated inactivity or legacy unused alert for this subscription
      const existing = existingAlerts.find(
        (a) =>
          !a.isManual &&
          (a.type === 'inactivity_review' || a.type === 'unused') &&
          (a.subscriptionIds.includes(sub.slug) || (sub._id && a.subscriptionIds.includes(sub._id.toString()))),
      )

      if (existing) {
        const updated = await Alert.findOneAndUpdate(
          ownedBy(userId, { _id: existing._id }),
          {
            $set: {
              type: 'inactivity_review',
              subType,
              severity,
              title,
              description,
              subscriptionIds: [sub.slug],
              impact,
              impactLabel,
              currentAmount: sub.amount,
              daysSinceLastPayment: sub.daysSinceLastPayment,
              daysOverdue: sub.daysOverdue,
              expectedBillingDate: sub.nextBillingDate,
              lastPaymentDate: sub.lastActivity,
              confidenceLabel,
            },
          },
          { new: true },
        )
        if (updated) {
          retainedAutomatedIds.add(updated._id.toString())
        }
      } else {
        const created = await Alert.create({
          userId,
          type: 'inactivity_review',
          subType,
          severity,
          title,
          description,
          subscriptionIds: [sub.slug],
          impact,
          impactLabel,
          currentAmount: sub.amount,
          daysSinceLastPayment: sub.daysSinceLastPayment,
          daysOverdue: sub.daysOverdue,
          expectedBillingDate: sub.nextBillingDate,
          lastPaymentDate: sub.lastActivity,
          confidenceLabel,
          isManual: false,
        })
        retainedAutomatedIds.add(created._id.toString())
      }
    }
  }

  // 4. Remove ONLY stale automated alerts for evaluated subscriptions that were not retained.
  // Never delete manual alerts or alerts belonging to unrelated subscriptions.
  const evaluatedSubSlugs = new Set(
    allSubscriptions
      .flatMap((s) => [s.slug, s._id?.toString(), s.id])
      .filter(Boolean),
  )
  const evaluatedDomains = new Set(
    allSubscriptions.map((s) => s.serviceDomain).filter(Boolean),
  )

  const staleAutomatedIds = existingAlerts
    .filter((a) => {
      if (a.isManual) return false
      // Payment-anomaly alerts are reconciled by anomalyAlertService, not here.
      if (a.type === ANOMALY_ALERT_TYPE) return false
      if (retainedAutomatedIds.has(a._id.toString())) return false
      const relatesToEvaluatedSub = a.subscriptionIds?.some((id) => evaluatedSubSlugs.has(id))
      const relatesToEvaluatedDomain = a.serviceDomain && evaluatedDomains.has(a.serviceDomain)
      return relatesToEvaluatedSub || relatesToEvaluatedDomain
    })
    .map((a) => a._id)

  if (staleAutomatedIds.length > 0) {
    await Alert.deleteMany(ownedBy(userId, { _id: { $in: staleAutomatedIds }, isManual: { $ne: true } }))
  }
}
