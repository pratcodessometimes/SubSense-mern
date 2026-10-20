/**
 * Recommendation Engine (Phase 4.3)
 *
 * Turns signals that detection already stored (subscription fields and payment-anomaly alerts)
 * into ranked, explainable recommendations. It is a transparent rules layer: no ML model, no
 * external AI, no probabilities. Recommendations are computed on every read and never persisted.
 *
 * Structure
 *   buildRecommendations(...)   pure + deterministic (same input -> same output, same order)
 *   loadRecommendations(userId) read-only, owner-scoped database access + the pure builder
 *
 * Ranking policy (RANKING_POLICY_VERSION)
 *   score = round((base + impactPoints) * focusWeight[category] + urgencyPoints)
 *   - base:          category + evidence strength (BASE_POINTS)
 *   - impactPoints:  1 point per ₹100/month of the relevant amount, capped at 20 (the cap is 30
 *                    under the reduce_costs focus). Only amounts the evidence supports are used;
 *                    "billing amount under review" counts at half weight because it is not a saving.
 *   - focusWeight:   per-category multiplier for the user's saved focus (FOCUS_WEIGHTS)
 *   - urgencyPoints: recent evidence +10, stale evidence (>180 days) -10, renewal within 14 days +5
 *   level: high >= 55, medium >= 30, otherwise low.
 *   Ties: score desc, then CATEGORY_ORDER, then id asc.
 *
 * Review decisions: subscriptions marked "not_subscription" never produce recommendations.
 * "confirmed" subscriptions still receive genuine price/duplicate/anomaly/inactivity findings but
 * never a "please review" prompt. Unreviewed prompts are limited (see UNREVIEWED_LIMIT).
 */
import { Alert } from '../models/Alert.js'
import { Subscription } from '../models/Subscription.js'
import { Transaction } from '../models/Transaction.js'
import { RECOMMENDATION_FOCUS_VALUES } from '../models/User.js'
import { ownedBy } from '../utils/ownership.js'
import {
  consolidationOpportunities,
  computeSavingsBreakdown,
  duplicateExposure,
  INACTIVITY_STATUSES,
  isCostEligible,
  isRejected,
  monthlyEquivalent,
  priceIncreaseImpact,
  round2,
  summarizeRecurringSpend,
  yearlyEquivalent,
} from './financialImpact.js'

export const RANKING_POLICY_VERSION = '4.3.0'

export const CATEGORY_ORDER = [
  'duplicate_billing',
  'payment_anomaly',
  'price_increase',
  'service_overlap',
  'inactivity_review',
  'unreviewed_subscription',
]

/**
 * Recommendation category -> alert visibility preference key. Must agree with the frontend's
 * alert mapping (frontend/src/lib/alertPreferences.ts); a test checks both stay consistent.
 * Unreviewed prompts are not alerts, so no visibility switch applies to them.
 */
export const ALERT_PREFERENCE_BY_CATEGORY = {
  duplicate_billing: 'duplicate',
  payment_anomaly: 'paymentAnomaly',
  price_increase: 'priceIncrease',
  service_overlap: 'serviceOverlap',
  inactivity_review: 'inactivity',
  unreviewed_subscription: null,
}

/** Alert type/subType -> preference key (server-side twin of alertCategory() in the frontend). */
export function alertPreferenceKey(alert) {
  if (alert.type === 'service_overlap' || alert.subType === 'service_overlap') return 'serviceOverlap'
  switch (alert.type) {
    case 'price_increase':
      return 'priceIncrease'
    case 'duplicate':
      return 'duplicate'
    case 'inactivity_review':
    case 'unused':
      return 'inactivity'
    case 'payment_anomaly':
      return 'paymentAnomaly'
    default:
      return null
  }
}

const BASE_POINTS = {
  duplicate_billing: { strong: 50, suspected: 35 },
  payment_anomaly: { amount_higher_than_usual: 38, paid_earlier_than_usual_or_duplicate: 36, amount_lower_than_usual: 28, paid_later_than_usual: 26 },
  price_increase: { default: 30, large: 36 },
  service_overlap: { default: 25 },
  inactivity_review: { potentially_inactive: 20, needs_review: 15, unused: 20 },
  unreviewed_subscription: { default: 12 },
}

export const FOCUS_WEIGHTS = {
  balanced: { duplicate_billing: 1, payment_anomaly: 1, price_increase: 1, service_overlap: 1, inactivity_review: 1, unreviewed_subscription: 1 },
  reduce_costs: { duplicate_billing: 1.3, payment_anomaly: 0.8, price_increase: 1.2, service_overlap: 1.5, inactivity_review: 0.9, unreviewed_subscription: 0.8 },
  billing_risks: { duplicate_billing: 1.4, payment_anomaly: 1.6, price_increase: 1, service_overlap: 0.6, inactivity_review: 1.1, unreviewed_subscription: 0.8 },
}

const LEVELS = [
  { level: 'high', min: 55 },
  { level: 'medium', min: 30 },
  { level: 'low', min: -Infinity },
]
const UNREVIEWED_LIMIT = 3
const UNREVIEWED_CONFIDENCE_THRESHOLD = 0.85
const UNREVIEWED_IMPORTANT_MONTHLY = 500
const DAY_MS = 24 * 60 * 60 * 1000

const inr = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
const per = (interval) => (interval === 'yearly' ? 'year' : 'month')
const slugOf = (s) => s.slug || String(s._id)
const toDate = (d) => {
  if (!d) return null
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? null : date
}
const daysBetween = (a, b) => Math.round((a.getTime() - b.getTime()) / DAY_MS)
const isoDay = (d) => toDate(d)?.toISOString().slice(0, 10)

function alertsFor(alerts, slug, predicate) {
  return alerts
    .filter((a) => !a.isManual && (a.subscriptionIds || []).includes(slug) && predicate(a))
    .map((a) => String(a._id))
    .sort()
}

// ---------------------------------------------------------------------------------- impact
function impact(type, { monthly = null, yearly = null, label, assumption, ...rest } = {}) {
  const usable = (n) => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? round2(n) : null)
  const m = usable(monthly)
  const y = usable(yearly)
  // An amount the evidence does not support is omitted (never replaced by 0 or a guess).
  if (type !== 'unquantified' && m === null && y === null && rest.oneTimeDifference === undefined) {
    return { type: 'unquantified', label: 'Amount not quantified' }
  }
  return {
    type,
    ...(m !== null ? { monthly: m } : {}),
    ...(y !== null ? { yearly: y } : {}),
    label,
    ...(assumption ? { assumption } : {}),
    ...rest,
  }
}

// ---------------------------------------------------------------------------------- builders
function duplicateRec(s, alerts) {
  const exposure = duplicateExposure(s)
  if (!exposure || !isCostEligible(s)) return null
  const slug = slugOf(s)
  const strong = exposure.strength === 'strong'
  const accounts = (s.duplicateAccounts || []).filter(Boolean)
  const evidence = [
    accounts.length > 1 ? `Charges for ${s.name} appear on ${accounts.length} accounts: ${accounts.join(', ')}` : null,
    accounts.length === 1 ? `More than one charge appeared on account "${accounts[0]}" in the same billing cycle` : null,
    `Extra charge: ${inr(s.duplicateAmount || s.amount)} per ${per(s.billingInterval)}`,
    `Detection evidence: ${strong ? 'strong (repeated or multi-account pattern)' : 'suspected (seen in a short window only)'}`,
  ].filter(Boolean)
  return {
    category: 'duplicate_billing',
    key: slug,
    subscription: s,
    title: strong ? `Review possible duplicate billing for ${s.name}` : `Check a possible extra charge for ${s.name}`,
    description: strong
      ? `${s.name} looks like it is being charged more than once.`
      : `${s.name} had more than one charge in a short period. This may be a duplicate, a retry or a plan change.`,
    explanation:
      `SubSense found ${accounts.length > 1 ? 'charges for the same service on different accounts' : 'more than one charge in the same billing window'}. ` +
      'This is a pattern in your transactions, not proof that a charge was wrong — your bank statement or the provider can confirm it.',
    evidence,
    action: {
      label: 'Compare your statements',
      detail: strong
        ? 'Check which account should be paying and whether you can cancel or get a refund for the extra charge.'
        : 'Check whether the extra charge was an upgrade, a retried payment or a genuine duplicate.',
    },
    impact: impact('potential_duplicate_exposure', {
      monthly: exposure.monthly,
      yearly: exposure.yearly,
      label: strong ? 'Possible duplicate charge' : 'Suspected duplicate charge (unverified)',
      basis: exposure.strength,
    }),
    evidenceLevel: strong ? 'strong' : 'moderate',
    evidenceLabel: strong ? 'Strong evidence' : 'Suspected — needs verification',
    basePoints: BASE_POINTS.duplicate_billing[exposure.strength],
    impactMonthly: exposure.monthly,
    evidenceDate: toDate(s.lastActivity),
    renewalDate: toDate(s.nextBillingDate),
    sourceAlertIds: alertsFor(alerts, slug, (a) => a.type === 'duplicate' && a.subType !== 'service_overlap'),
  }
}

function priceRec(s, alerts) {
  const p = priceIncreaseImpact(s)
  if (!p || isRejected(s) || s.status === 'confirmed_cancelled') return null
  const slug = slugOf(s)
  const increaseDate = toDate(s.priceIncreaseDate)
  return {
    category: 'price_increase',
    key: slug,
    subscription: s,
    title: `Your ${s.name} price increased`,
    description: `${s.name} now costs ${inr(p.currentAmount)} per ${per(s.billingInterval)}, up from ${inr(p.previousAmount)} (+${p.percentChange}%).`,
    explanation:
      'Your recent payments are higher than earlier ones at a steady new level, which usually means a price or plan change. ' +
      'This is extra cost to be aware of, not a saving.',
    evidence: [
      `Previous amount: ${inr(p.previousAmount)} per ${per(s.billingInterval)}`,
      `Current amount: ${inr(p.currentAmount)} per ${per(s.billingInterval)}`,
      `Change: +${p.percentChange}%`,
      increaseDate ? `First seen at the new price on ${isoDay(increaseDate)}` : null,
    ].filter(Boolean),
    action: {
      label: 'Review your plan',
      detail: 'Check whether a cheaper plan, an annual option or a different tier still covers what you need.',
    },
    impact: impact('additional_cost', {
      monthly: p.monthly,
      yearly: p.yearly,
      label: 'Additional cost from the price increase',
      previousAmount: p.previousAmount,
      currentAmount: p.currentAmount,
      percentChange: p.percentChange,
    }),
    evidenceLevel: 'strong',
    evidenceLabel: 'Observed in your payments',
    basePoints: p.percentChange >= 20 ? BASE_POINTS.price_increase.large : BASE_POINTS.price_increase.default,
    impactMonthly: p.monthly,
    evidenceDate: increaseDate,
    renewalDate: toDate(s.nextBillingDate),
    sourceAlertIds: alertsFor(alerts, slug, (a) => a.type === 'price_increase'),
  }
}

function overlapRecs(subscriptions, alerts, strongDuplicateIds) {
  const byId = new Map(subscriptions.map((s) => [slugOf(s), s]))
  return consolidationOpportunities(subscriptions, { excludeIds: strongDuplicateIds }).map((op) => {
    const names = op.subscriptions.map((i) => i.name)
    const list = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
    const candidateNames = op.candidates.map((c) => c.name)
    return {
      category: 'service_overlap',
      key: op.serviceDomain,
      subscription: byId.get(op.keep.id),
      relatedIds: op.subscriptionIds,
      title: `These ${op.domainLabel} services may overlap`,
      description: `You pay for ${list}, which serve a similar purpose.`,
      explanation:
        'Several of your subscriptions fall into the same service category. You may well use all of them — ' +
        'SubSense only points out the overlap so you can decide whether each one is still needed.',
      evidence: [
        ...op.subscriptions.map((i) => `${i.name}: ${inr(i.amount)} per ${per(i.billingInterval)} (≈ ${inr(i.monthlyAmount)}/month)`),
        `Combined: ≈ ${inr(op.totalMonthly)}/month`,
        op.excludedAsDuplicate.length ? 'Services already listed under duplicate billing are not counted again here' : null,
      ].filter(Boolean),
      action: {
        label: 'Decide which services you still need',
        detail: 'If you rarely use one of them, consider consolidating to fewer services.',
      },
      impact: op.candidates.length
        ? impact('conditional_savings', {
          monthly: op.monthly,
          yearly: op.yearly,
          label: 'Possible saving if you consolidate',
          assumption: `Only if you keep ${op.keep.name} and cancel ${candidateNames.join(', ')}.`,
        })
        : impact('unquantified', { label: 'Overlap noted; no separate saving to estimate' }),
      evidenceLevel: 'moderate',
      evidenceLabel: 'Same service category',
      basePoints: BASE_POINTS.service_overlap.default,
      impactMonthly: op.candidates.length ? op.monthly : 0,
      evidenceDate: null,
      renewalDate: null,
      sourceAlertIds: alerts
        .filter((a) => !a.isManual && (a.type === 'service_overlap' || a.subType === 'service_overlap') &&
          (a.serviceDomain === op.serviceDomain || op.subscriptionIds.some((id) => (a.subscriptionIds || []).includes(id))))
        .map((a) => String(a._id))
        .sort(),
    }
  })
}

function inactivityRec(s, alerts, now) {
  if (isRejected(s) || !INACTIVITY_STATUSES.has(s.status)) return null
  const slug = slugOf(s)
  const expected = toDate(s.nextBillingDate)
  const last = toDate(s.lastActivity)
  const monthly = monthlyEquivalent(s.amount, s.billingInterval)
  const limitedHistory = s.status === 'needs_review'
  return {
    category: 'inactivity_review',
    key: slug,
    subscription: s,
    title: `An expected ${s.name} payment was not observed`,
    description: expected
      ? `SubSense expected a ${s.name} payment around ${isoDay(expected)} but has not seen one${s.daysOverdue > 0 ? ` (${s.daysOverdue} days ago)` : ''}.`
      : `SubSense has not seen a recent ${s.name} payment.`,
    explanation:
      'A missing payment does not mean you stopped using the service. It may be paused, cancelled, billed to another ' +
      'card or account, or simply not imported yet.' + (limitedHistory ? ' There are only a few past payments, so the usual timing is uncertain.' : ''),
    evidence: [
      last ? `Last payment seen: ${isoDay(last)}` : null,
      expected ? `Expected around: ${isoDay(expected)}` : null,
      `Usual amount: ${inr(s.amount)} per ${per(s.billingInterval)}`,
      s.inactivityEvidence || null,
    ].filter(Boolean),
    action: {
      label: 'Verify the subscription status',
      detail: 'Check whether it was paused, cancelled or moved to another account. If you still pay for it elsewhere, import that statement too.',
    },
    impact: impact('billing_amount_under_review', {
      monthly,
      yearly: yearlyEquivalent(s.amount, s.billingInterval),
      label: 'Billing amount under review (not a saving)',
    }),
    evidenceLevel: limitedHistory ? 'limited' : 'moderate',
    evidenceLabel: limitedHistory ? 'Limited payment history' : 'Expected payment not observed',
    basePoints: BASE_POINTS.inactivity_review[s.status],
    impactMonthly: monthly ? monthly / 2 : 0,
    evidenceDate: expected,
    renewalDate: null,
    sourceAlertIds: alertsFor(alerts, slug, (a) => a.type === 'inactivity_review' || a.type === 'unused'),
  }
}

const ANOMALY_COPY = {
  amount_higher_than_usual: { title: 'charged more than usual', action: 'Check whether this was a one-off charge, a plan change or a billing error.' },
  amount_lower_than_usual: { title: 'charged less than usual', action: 'Check whether a discount, partial refund or plan change explains it.' },
  paid_earlier_than_usual_or_duplicate: { title: 'charged earlier than usual', action: 'Check whether this was an early renewal or an extra charge.' },
  paid_later_than_usual: { title: 'charged later than usual', action: 'Check whether the billing date moved or a payment was retried.' },
}

function anomalyRec(alert, sub) {
  const reason = alert.anomalyReason
  const copy = ANOMALY_COPY[reason]
  if (!copy) return null
  const name = sub?.name || alert.subscriptionIds?.[0] || 'A subscription'
  const isTiming = reason === 'paid_earlier_than_usual_or_duplicate' || reason === 'paid_later_than_usual'
  const charged = alert.currentAmount
  const usual = alert.expectedAmount ?? alert.previousAmount
  const hasAmounts = typeof charged === 'number' && typeof usual === 'number' && usual > 0
  const diff = hasAmounts ? round2(charged - usual) : null
  const paymentDate = toDate(alert.paymentDate)
  return {
    category: 'payment_anomaly',
    key: alert.anomalyKey || String(alert._id),
    subscription: sub,
    // Always link to the alert's subscription slug, even if that record is not loaded.
    relatedIds: (alert.subscriptionIds || []).slice(0, 1),
    title: `${name} was ${copy.title}`,
    description: 'This payment differs from your usual pattern for this subscription.',
    explanation:
      (isTiming
        ? `The gap since the previous charge (${alert.actualIntervalDays ?? '?'} days) is unusual compared with your normal ~${Math.round(alert.expectedIntervalDays ?? 0) || '?'} days.`
        : `The amount (${hasAmounts ? inr(charged) : 'this charge'}) is unusual compared with what you normally pay${hasAmounts ? ` (${inr(usual)})` : ''}.`) +
      ' This is a statistical comparison with your own past payments, not a confirmed error or fraud.',
    evidence: [
      paymentDate ? `Payment date: ${isoDay(paymentDate)}` : null,
      hasAmounts ? `Charged: ${inr(charged)} · usual: ${inr(usual)}` : null,
      isTiming && alert.actualIntervalDays !== undefined ? `Days since previous charge: ${alert.actualIntervalDays} (usually ~${Math.round(alert.expectedIntervalDays)})` : null,
      typeof alert.anomalyScore === 'number' ? `Deviation score: ${alert.anomalyScore.toFixed(1)} (robust deviation from your history; not a probability)` : null,
    ].filter(Boolean),
    action: { label: 'Check this payment', detail: copy.action },
    impact: !isTiming && diff !== null && diff !== 0
      ? impact('billing_amount_under_review', {
        label: diff > 0 ? 'Amount above your usual payment' : 'Amount below your usual payment',
        oneTimeDifference: diff,
        chargedAmount: round2(charged),
        usualAmount: round2(usual),
      })
      : impact('unquantified', { label: 'Timing difference (no amount at stake)' }),
    anomalyReason: reason,
    evidenceLevel: 'moderate',
    evidenceLabel: 'Unusual compared with your history',
    basePoints: BASE_POINTS.payment_anomaly[reason],
    impactMonthly: diff !== null && diff > 0 ? diff : 0,
    evidenceDate: paymentDate,
    renewalDate: null,
    sourceAlertIds: [String(alert._id)],
  }
}

function unreviewedRecs(subscriptions, alerts, others) {
  const flagged = new Set(others.flatMap((r) => (r.subscription ? [slugOf(r.subscription)] : [])))
  return subscriptions
    .filter((s) => (s.reviewStatus ?? 'unreviewed') === 'unreviewed' && !isRejected(s) && s.status !== 'confirmed_cancelled')
    .filter((s) => {
      const monthly = monthlyEquivalent(s.amount, s.billingInterval) || 0
      // Ask only when it is useful: limited detection confidence, or a large share of the totals.
      return (typeof s.confidence === 'number' && s.confidence < UNREVIEWED_CONFIDENCE_THRESHOLD) ||
        (monthly >= UNREVIEWED_IMPORTANT_MONTHLY && !flagged.has(slugOf(s)))
    })
    .sort((a, b) => (a.confidence ?? 1) - (b.confidence ?? 1) || slugOf(a).localeCompare(slugOf(b)))
    .slice(0, UNREVIEWED_LIMIT)
    .map((s) => ({
      category: 'unreviewed_subscription',
      key: slugOf(s),
      subscription: s,
      title: `Is ${s.name} a subscription?`,
      description: `SubSense detected ${s.name} as a recurring payment. Confirming it keeps your totals accurate.`,
      explanation:
        typeof s.confidence === 'number' && s.confidence < UNREVIEWED_CONFIDENCE_THRESHOLD
          ? 'The payment pattern is less regular than usual, so a quick confirmation helps.'
          : `At about ${inr(monthlyEquivalent(s.amount, s.billingInterval))}/month it affects your recurring totals noticeably.`,
      evidence: [
        `${s.transactionCount ?? '?'} payments of about ${inr(s.amount)} per ${per(s.billingInterval)}`,
        typeof s.confidence === 'number' ? `Detection confidence: ${Math.round(s.confidence * 100)}% (rule-based score)` : null,
      ].filter(Boolean),
      action: { label: 'Confirm or reject', detail: 'Open the subscription and tell SubSense whether it is a real subscription.' },
      impact: impact('unquantified', { label: 'Classification check' }),
      evidenceLevel: typeof s.confidence === 'number' && s.confidence < UNREVIEWED_CONFIDENCE_THRESHOLD ? 'limited' : 'moderate',
      evidenceLabel: 'Awaiting your review',
      basePoints: BASE_POINTS.unreviewed_subscription.default,
      impactMonthly: 0,
      evidenceDate: null,
      renewalDate: null,
      sourceAlertIds: [],
    }))
}

// ---------------------------------------------------------------------------------- ranking
export function scoreRecommendation(rec, focus, now) {
  const weights = FOCUS_WEIGHTS[focus] || FOCUS_WEIGHTS.balanced
  const cap = focus === 'reduce_costs' ? 30 : 20
  const factors = [{ factor: 'evidence', points: rec.basePoints, detail: rec.evidenceLabel }]
  const impactPoints = Math.min(cap, Math.floor((rec.impactMonthly || 0) / 100))
  if (impactPoints > 0) factors.push({ factor: 'financial_impact', points: impactPoints, detail: '1 point per ₹100/month' })

  let urgency = 0
  if (rec.evidenceDate) {
    const age = daysBetween(now, rec.evidenceDate)
    if (age >= 0 && age <= 45) {
      urgency += 10
      factors.push({ factor: 'recent', points: 10, detail: `Evidence from ${age} days ago` })
    } else if (age > 180) {
      urgency -= 10
      factors.push({ factor: 'older_finding', points: -10, detail: `Evidence is ${age} days old` })
    }
  }
  if (rec.renewalDate) {
    const until = daysBetween(rec.renewalDate, now)
    if (until >= 0 && until <= 14) {
      urgency += 5
      factors.push({ factor: 'renewal_soon', points: 5, detail: `Renews in ${until} days` })
    }
  }
  const weight = weights[rec.category] ?? 1
  if (weight !== 1) factors.push({ factor: 'focus', multiplier: weight, detail: `Your focus: ${focus}` })

  const score = Math.round((rec.basePoints + impactPoints) * weight + urgency)
  const level = LEVELS.find((l) => score >= l.min).level
  return { score, level, factors }
}

export function compareRecommendations(a, b) {
  return b.priority.score - a.priority.score ||
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
    a.id.localeCompare(b.id)
}

// ---------------------------------------------------------------------------------- builder
/**
 * Pure, deterministic recommendation builder.
 * @param {{ subscriptions: any[], alerts: any[], preferences?: { alerts?: object, recommendationFocus?: string },
 *           transactionCount?: number, now?: Date }} input
 */
export function buildRecommendations({ subscriptions = [], alerts = [], preferences = {}, transactionCount = null, now = new Date() }) {
  const focus = RECOMMENDATION_FOCUS_VALUES.includes(preferences.recommendationFocus) ? preferences.recommendationFocus : 'balanced'
  const visibility = preferences.alerts || {}
  const subs = [...subscriptions].filter((s) => !isRejected(s)).sort((a, b) => slugOf(a).localeCompare(slugOf(b)))
  const bySlug = new Map(subs.map((s) => [slugOf(s), s]))
  const rejectedSlugs = new Set(subscriptions.filter(isRejected).map(slugOf))

  const drafts = []
  const strongDuplicateIds = new Set()
  for (const s of subs) {
    const dup = duplicateRec(s, alerts)
    if (dup) {
      drafts.push(dup)
      if (dup.impact.basis === 'strong') strongDuplicateIds.add(slugOf(s))
    }
    const price = priceRec(s, alerts)
    if (price) drafts.push(price)
    const inactive = inactivityRec(s, alerts, now)
    if (inactive) drafts.push(inactive)
  }
  drafts.push(...overlapRecs(subs, alerts, strongDuplicateIds))
  for (const a of [...alerts].sort((x, y) => String(x.anomalyKey || x._id).localeCompare(String(y.anomalyKey || y._id)))) {
    if (a.type !== 'payment_anomaly' || a.isManual) continue
    const slug = a.subscriptionIds?.[0]
    if (!slug || rejectedSlugs.has(slug)) continue // a rejected subscription never yields recommendations
    const rec = anomalyRec(a, bySlug.get(slug))
    if (rec) drafts.push(rec)
  }
  drafts.push(...unreviewedRecs(subs, alerts, drafts))

  const all = drafts.map((d) => {
    const priority = scoreRecommendation(d, focus, now)
    const subscriptionIds = d.relatedIds || (d.subscription ? [slugOf(d.subscription)] : [])
    return {
      id: `${d.category}:${d.key}`,
      category: d.category,
      alertCategory: ALERT_PREFERENCE_BY_CATEGORY[d.category],
      title: d.title,
      description: d.description,
      explanation: d.explanation,
      evidence: d.evidence,
      action: d.action,
      impact: d.impact,
      evidenceLevel: d.evidenceLevel,
      evidenceLabel: d.evidenceLabel,
      ...(d.anomalyReason ? { anomalyReason: d.anomalyReason } : {}),
      priority,
      subscriptionIds,
      primarySubscriptionId: subscriptionIds[0] ?? null,
      reviewStatus: d.subscription ? (d.subscription.reviewStatus ?? 'unreviewed') : null,
      sourceAlertIds: d.sourceAlertIds,
    }
  }).sort(compareRecommendations)

  // In-app alert visibility (Phase 4.2) also hides the matching recommendation cards.
  const isVisible = (r) => !r.alertCategory || visibility[r.alertCategory] !== false
  const recommendations = all.filter(isVisible)
  const hidden = all.filter((r) => !isVisible(r))
  const hiddenByCategory = {}
  for (const r of hidden) hiddenByCategory[r.category] = (hiddenByCategory[r.category] || 0) + 1

  const spend = summarizeRecurringSpend(subs)
  const { potentialSavings, breakdown } = computeSavingsBreakdown(subs)
  return {
    recommendations,
    hidden: { count: hidden.length, byCategory: hiddenByCategory },
    summary: {
      transactionCount,
      subscriptionCount: subs.length,
      rejectedCount: rejectedSlugs.size,
      unreviewedCount: subs.filter((s) => (s.reviewStatus ?? 'unreviewed') === 'unreviewed').length,
      confirmedCount: subs.filter((s) => s.reviewStatus === 'confirmed').length,
      activeSubscriptions: spend.activeSubscriptions,
      monthlyRecurringSpend: spend.monthlySpend,
      potentialSavings,
      savingsBreakdown: breakdown,
      byPriority: {
        high: recommendations.filter((r) => r.priority.level === 'high').length,
        medium: recommendations.filter((r) => r.priority.level === 'medium').length,
        low: recommendations.filter((r) => r.priority.level === 'low').length,
      },
    },
    meta: {
      focus,
      rankingPolicyVersion: RANKING_POLICY_VERSION,
      method: 'Rule-based analysis of your transactions and detected subscriptions (no machine-learning predictions).',
      generatedAt: now.toISOString(),
    },
  }
}

/** Read-only, owner-scoped: loads the user's records and builds recommendations. Never writes. */
export async function loadRecommendations(userId, preferences, now = new Date()) {
  const [subscriptions, alerts, transactionCount] = await Promise.all([
    Subscription.find(ownedBy(userId)),
    Alert.find(ownedBy(userId)),
    Transaction.countDocuments(ownedBy(userId)),
  ])
  return buildRecommendations({ subscriptions, alerts, preferences, transactionCount, now })
}
