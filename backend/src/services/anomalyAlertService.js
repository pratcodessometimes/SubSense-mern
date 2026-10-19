/**
 * Anomaly Alert Service (Phase 3.3)
 *
 * Turns robust payment-anomaly scores into `payment_anomaly` alerts for
 * subscriptions that the RULE-BASED detector has already detected. The rule
 * engine stays the only subscription detector; this service only explains
 * unusual individual payments inside those subscriptions.
 *
 * Safeguards
 *  1. De-duplication with Phase 2:
 *     - higher-amount flags are suppressed when a Phase 2 price increase covers
 *       the payment (on/after priceIncreaseDate and at the new price tier);
 *     - early/duplicate timing flags are suppressed ONLY with duplicate
 *       evidence: hasDuplicateCharges AND the gap is within the duplicate
 *       detector's proximity window AND the amount matches the usual amount.
 *  2. Only prior payments are used for scoring (see paymentAnomalyService);
 *     only RECENT payments (within 1.5 billing intervals of the reference date)
 *     can raise alerts, so old history does not resurface.
 *  3. Idempotent upserts keyed by (userId, anomalyKey) (per-user unique index,
 *     Phase 4.1); an E11000 duplicate-key race from a concurrent run is retried
 *     as an update. Manual alerts are never modified or deleted.
 *  5. User isolation (Phase 4.1): every alert read, upsert and delete is scoped
 *     to the owning user, so identical anomaly keys of different users never meet.
 *  4. Failure isolation: errors are caught and reported in the summary; the
 *     rule-based detection results are never affected.
 */

import { ANOMALY_CONFIG, describeAnomaly, scorePaymentHistory, toUtcDayNumber } from './paymentAnomalyService.js'
import { ownedBy, requireUserId } from '../utils/ownership.js'

export const ANOMALY_ALERT_TYPE = 'payment_anomaly'
const DAY_MS = 24 * 60 * 60 * 1000
const LOOKBACK_FACTOR = 1.5
// Same thresholds the Phase 2 detectors use (detectDuplicateCharges / detectPriceIncrease).
const DUPLICATE_PROXIMITY_DAYS = { monthly: 20, yearly: 180 }
const DUPLICATE_AMOUNT_TOLERANCE = 0.15
const PRICE_TIER_TOLERANCE = 0.035

const TIMING_REASONS = new Set(['paid_earlier_than_usual_or_duplicate', 'paid_later_than_usual'])

export function isAnomalyDetectionEnabled(env = process.env) {
  return String(env.ANOMALY_DETECTION_ENABLED ?? 'true').trim().toLowerCase() !== 'false'
}

export function buildAnomalyKey(slug, payment) {
  const ref = payment.transactionId || `${payment.date}:${payment.amount}`
  return `${ANOMALY_ALERT_TYPE}:${slug}:${ref}`
}

/**
 * Decide whether a flagged payment should raise an alert.
 * @returns {{ action: 'alert' | 'suppress', because?: string }}
 */
export function classifyAnomaly(payment, sub, referenceDay) {
  const interval = sub.billingInterval === 'yearly' ? 'yearly' : 'monthly'
  const lookbackDays = Math.ceil(LOOKBACK_FACTOR * (interval === 'yearly' ? 365 : 30))
  if (payment.day > referenceDay || referenceDay - payment.day > lookbackDays) {
    return { action: 'suppress', because: 'outside_recent_window' }
  }

  if (payment.reason === 'amount_higher_than_usual') {
    const increaseDay = toUtcDayNumber(sub.priceIncreaseDate)
    const hasIncrease = Number(sub.previousAmount) > 0 && Number(sub.amount) > Number(sub.previousAmount)
    const atNewTier = Number(sub.amount) > 0 &&
      Math.abs(payment.amount - Number(sub.amount)) / Number(sub.amount) <= PRICE_TIER_TOLERANCE
    if (hasIncrease && increaseDay !== null && payment.day >= increaseDay && atNewTier) {
      return { action: 'suppress', because: 'covered_by_price_increase_alert' }
    }
  }

  if (payment.reason === 'paid_earlier_than_usual_or_duplicate' && sub.hasDuplicateCharges === true) {
    const withinDuplicateWindow = payment.intervalDays <= DUPLICATE_PROXIMITY_DAYS[interval]
    const sameAmount = payment.refMedianAmount > 0 &&
      Math.abs(payment.amount - payment.refMedianAmount) / payment.refMedianAmount <= DUPLICATE_AMOUNT_TOLERANCE
    if (withinDuplicateWindow && sameAmount) {
      return { action: 'suppress', because: 'covered_by_duplicate_charge_alert' }
    }
  }

  return { action: 'alert' }
}

const round2 = (n) => Math.round(n * 100) / 100
const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

export function buildAnomalyAlertDoc(sub, p) {
  const isTiming = TIMING_REASONS.has(p.reason)
  const name = sub.name || sub.slug
  const titles = {
    amount_higher_than_usual: `Unusual charge amount: ${name}`,
    amount_lower_than_usual: `Unusually low charge: ${name}`,
    paid_earlier_than_usual_or_duplicate: `Charged earlier than usual: ${name}`,
    paid_later_than_usual: `Charged later than usual: ${name}`,
  }
  const diff = round2(p.amount - p.refMedianAmount)
  const pct = p.refMedianAmount > 0 ? Math.round((diff / p.refMedianAmount) * 1000) / 10 : 0
  const doc = {
    type: ANOMALY_ALERT_TYPE,
    subType: isTiming ? 'unusual_timing' : 'unusual_amount',
    severity: 'warning',
    title: titles[p.reason] || `Unusual payment: ${name}`,
    description: describeAnomaly(p, name),
    subscriptionIds: [sub.slug],
    impact: isTiming ? `${p.intervalDays} days since previous charge` : `${diff >= 0 ? '+' : '−'}${inr(Math.abs(diff))} vs usual`,
    impactLabel: isTiming
      ? `Usually every ~${Math.round(p.refMedianInterval)} days`
      : `Usual amount ${inr(round2(p.refMedianAmount))}`,
    currentAmount: round2(p.amount),
    previousAmount: round2(p.refMedianAmount),
    percentageChange: isTiming ? undefined : pct,
    confidenceLabel: `Deviation score ${p.score.toFixed(1)} (alert above ${ANOMALY_CONFIG.zThreshold})`,
    anomalyKey: buildAnomalyKey(sub.slug, p),
    transactionId: p.transactionId || undefined,
    anomalyReason: p.reason,
    anomalyScore: Math.round(p.score * 1000) / 1000,
    expectedAmount: round2(p.refMedianAmount),
    expectedIntervalDays: p.refMedianInterval,
    actualIntervalDays: p.intervalDays,
    paymentDate: new Date(p.day * DAY_MS),
    detectorVersion: ANOMALY_CONFIG.version,
    isManual: false,
  }
  // Never send `undefined` in an update ($set); drop those keys instead.
  return Object.fromEntries(Object.entries(doc).filter(([, v]) => v !== undefined))
}

/**
 * Idempotent upsert keyed by (userId, anomalyKey). Never touches manual alerts or other users' alerts.
 * On insert, the userId equality in the filter becomes the new alert's owner.
 * @returns {Promise<'created' | 'updated' | 'updated_after_conflict' | 'skipped_manual'>}
 */
export async function upsertAnomalyAlert(AlertModel, doc, userId) {
  const filter = ownedBy(userId, { anomalyKey: doc.anomalyKey, isManual: { $ne: true } })
  const existing = await AlertModel.findOne(ownedBy(userId, { anomalyKey: doc.anomalyKey }))
  if (existing && existing.isManual) return 'skipped_manual'
  const opts = { new: true, runValidators: true }
  try {
    await AlertModel.findOneAndUpdate(filter, { $set: doc }, { ...opts, upsert: true, setDefaultsOnInsert: true })
    return existing ? 'updated' : 'created'
  } catch (err) {
    if (err && err.code === 11000) {
      // A concurrent detection run inserted the same key first: update it instead.
      const updated = await AlertModel.findOneAndUpdate(filter, { $set: doc }, opts)
      return updated ? 'updated_after_conflict' : 'skipped_manual'
    }
    throw err
  }
}

/**
 * Score recent payments of rule-detected subscriptions and reconcile alerts.
 * Never throws: failures are returned as { status: 'failed' }.
 */
export async function runPaymentAnomalyDetection({
  userId,
  subscriptions,
  transactionsBySlug,
  referenceDate = null,
  AlertModel,
  env = process.env,
  scorer = scorePaymentHistory,
  logger = console,
}) {
  const summary = {
    status: 'completed',
    detectorVersion: ANOMALY_CONFIG.version,
    evaluatedSubscriptions: 0,
    insufficientHistory: 0,
    scoredPayments: 0,
    flaggedPayments: 0,
    skippedInvalidTransactions: 0,
    excludedByReview: 0,
    suppressed: { outside_recent_window: 0, covered_by_price_increase_alert: 0, covered_by_duplicate_charge_alert: 0 },
    alerts: { created: 0, updated: 0, updated_after_conflict: 0, skipped_manual: 0, removed: 0 },
    errors: [],
  }
  if (!isAnomalyDetectionEnabled(env)) return { ...summary, status: 'disabled' }

  try {
    requireUserId(userId)
    const referenceDay = toUtcDayNumber(referenceDate ?? new Date())
    if (referenceDay === null) throw new Error(`invalid referenceDate: ${referenceDate}`)

    const evaluatedSlugs = []
    const docs = []
    for (const sub of subscriptions || []) {
      if (!sub || !sub.slug) continue
      // Phase 4.2: a subscription the user marked "not a subscription" raises no anomaly alerts.
      // It still counts as evaluated, so its existing automated anomaly alerts are removed below.
      if (sub.reviewStatus === 'not_subscription') {
        evaluatedSlugs.push(sub.slug)
        summary.excludedByReview++
        continue
      }
      try {
        const result = scorer(transactionsBySlug.get(sub.slug) || [])
        evaluatedSlugs.push(sub.slug)
        summary.evaluatedSubscriptions++
        summary.skippedInvalidTransactions += result.skippedInvalid || 0
        if (result.status === 'insufficient_history') {
          summary.insufficientHistory++
          continue
        }
        summary.scoredPayments += result.payments.length
        for (const p of result.payments) {
          if (!p.isAnomaly) continue
          summary.flaggedPayments++
          const decision = classifyAnomaly(p, sub, referenceDay)
          if (decision.action === 'suppress') summary.suppressed[decision.because]++
          else docs.push(buildAnomalyAlertDoc(sub, p))
        }
      } catch (err) {
        // A failing subscription is NOT added to evaluatedSlugs, so its existing alerts are kept.
        summary.errors.push({ subscription: sub.slug, error: err.message })
      }
    }

    for (const doc of docs) {
      summary.alerts[await upsertAnomalyAlert(AlertModel, doc, userId)]++
    }

    if (evaluatedSlugs.length > 0) {
      const removed = await AlertModel.deleteMany(ownedBy(userId, {
        type: ANOMALY_ALERT_TYPE,
        isManual: { $ne: true },
        subscriptionIds: { $in: evaluatedSlugs },
        anomalyKey: { $nin: docs.map((d) => d.anomalyKey) },
      }))
      summary.alerts.removed = removed?.deletedCount ?? 0
    }
    if (summary.errors.length) summary.status = 'completed_with_errors'
    return summary
  } catch (err) {
    logger.error('Payment anomaly detection failed (rule-based results unaffected):', err.message)
    return { ...summary, status: 'failed', errors: [...summary.errors, { error: err.message }] }
  }
}
