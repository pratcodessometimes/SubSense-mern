/**
 * Financial impact helpers (Phase 4.3).
 *
 * Pure functions shared by the analytics KPIs and the recommendation engine so both report
 * identical numbers. Nothing here touches the database or the detection algorithms; it only
 * interprets fields that detection already stored on subscriptions.
 *
 * Categories are kept strictly separate:
 *   duplicateExposure          extra charges with strong duplicate evidence (high/medium confidence)
 *   suspectedDuplicateExposure extra charges flagged as only *suspected* duplicates   (not in total)
 *   conditionalSavings         cost of overlapping secondary services, IF consolidated
 *   inactivityReviewAmount     billing amount of subscriptions with missing payments  (not in total)
 *   priceIncreaseImpact        additional cost from price increases                   (not in total)
 *
 *   potentialSavings = duplicateExposure + conditionalSavings
 *
 * A subscription already counted in duplicateExposure is not also counted as an overlap secondary,
 * so no subscription contributes to the total twice.
 */
import { detectServiceOverlaps } from './detectionService.js'

export const round2 = (n) => Math.round(n * 100) / 100
const isAmount = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0

/** Statuses meaning "expected billing was not observed" — never a source of savings. */
export const INACTIVITY_STATUSES = new Set(['potentially_inactive', 'needs_review', 'unused'])
/** Statuses counted as active recurring spend (unchanged from the original KPI definition). */
const ACTIVE_STATUSES = new Set(['active', 'price_increase', 'duplicate'])

export function monthlyEquivalent(amount, billingInterval) {
  if (!isAmount(amount)) return null
  return billingInterval === 'yearly' ? round2(amount / 12) : round2(amount)
}

export function yearlyEquivalent(amount, billingInterval) {
  if (!isAmount(amount)) return null
  return billingInterval === 'yearly' ? round2(amount) : round2(amount * 12)
}

export const isRejected = (s) => s?.reviewStatus === 'not_subscription'

/** Subscriptions eligible for cost-reduction estimates: not rejected, not inactive, not cancelled. */
export function isCostEligible(s) {
  return !isRejected(s) && !INACTIVITY_STATUSES.has(s.status) && s.status !== 'confirmed_cancelled'
}

/** Extra charge per billing period implied by duplicate evidence, as monthly/yearly equivalents. */
export function duplicateExposure(s) {
  if (!s?.hasDuplicateCharges) return null
  const perPeriod = isAmount(s.duplicateAmount) ? s.duplicateAmount : s.amount
  const monthly = monthlyEquivalent(perPeriod, s.billingInterval)
  if (monthly === null) return null
  return {
    monthly,
    yearly: yearlyEquivalent(perPeriod, s.billingInterval),
    strength: s.duplicateConfidence === 'suspected' ? 'suspected' : 'strong',
  }
}

/** Additional cost of a price increase (never a saving). */
export function priceIncreaseImpact(s) {
  if (!isAmount(s?.previousAmount) || !isAmount(s?.amount) || s.amount <= s.previousAmount) return null
  const diff = round2(s.amount - s.previousAmount)
  return {
    previousAmount: s.previousAmount,
    currentAmount: s.amount,
    percentChange: round2((diff / s.previousAmount) * 100),
    monthly: monthlyEquivalent(diff, s.billingInterval),
    yearly: yearlyEquivalent(diff, s.billingInterval),
  }
}

/**
 * Service overlaps among cost-eligible subscriptions, with a conditional estimate per group:
 * keep the most expensive service, the others are the consolidation candidates. Candidates that
 * already count as strong duplicate exposure are excluded from the estimate (no double counting).
 */
export function consolidationOpportunities(subscriptions, { excludeIds = new Set() } = {}) {
  const eligible = (subscriptions || []).filter(isCostEligible)
  return detectServiceOverlaps(eligible).map((ov) => {
    const byCost = [...ov.subscriptions].sort((a, b) => b.monthlyAmount - a.monthlyAmount || String(a.id).localeCompare(String(b.id)))
    const keep = byCost[0]
    const candidates = byCost.slice(1).filter((item) => !excludeIds.has(item.id))
    return {
      serviceDomain: ov.serviceDomain,
      domainLabel: ov.domainLabel,
      subscriptionIds: ov.subscriptionIds,
      subscriptions: byCost,
      keep,
      candidates,
      excludedAsDuplicate: byCost.slice(1).filter((item) => excludeIds.has(item.id)).map((item) => item.id),
      monthly: round2(candidates.reduce((sum, i) => sum + i.monthlyAmount, 0)),
      yearly: round2(candidates.reduce((sum, i) => sum + i.yearlyAmount, 0)),
      totalMonthly: ov.totalMonthly,
    }
  })
}

const subId = (s) => s.slug || s._id?.toString() || s.id || s.name

/** Counted as active recurring spend: not rejected by the user and in an active detection status. */
export const isActiveRecurring = (s) => !isRejected(s) && ACTIVE_STATUSES.has(s?.status)

/** Active recurring spend (same definition as the original dashboard KPI). */
export function summarizeRecurringSpend(subscriptions) {
  const active = (subscriptions || []).filter(isActiveRecurring)
  const monthlySpend = active.reduce((sum, s) => sum + (monthlyEquivalent(s.amount, s.billingInterval) || 0), 0)
  return { activeSubscriptions: active.length, monthlySpend: round2(monthlySpend) }
}

export const SAVINGS_FORMULA = 'potentialSavings = duplicateExposure + conditionalSavings (monthly equivalents)'
export const SAVINGS_EXPLANATION =
  'Estimate = extra charges with strong duplicate-billing evidence + what you would stop paying if overlapping ' +
  'services were consolidated (conditional: keeps the most expensive service in each group). Suspected duplicates, ' +
  'price increases and subscriptions with missing payments are shown separately and are NOT included: missing ' +
  'payment activity does not mean a subscription can be cancelled for a saving. A subscription counted as a ' +
  'duplicate is not counted again as an overlap.'

/** Savings breakdown for the dashboard (all values are monthly equivalents in INR). */
export function computeSavingsBreakdown(subscriptions) {
  const subs = (subscriptions || []).filter((s) => !isRejected(s))

  let strong = 0
  let suspected = 0
  const strongDuplicateIds = new Set()
  for (const s of subs.filter(isCostEligible)) {
    const exposure = duplicateExposure(s)
    if (!exposure) continue
    if (exposure.strength === 'strong') {
      strong += exposure.monthly
      strongDuplicateIds.add(subId(s))
    } else {
      suspected += exposure.monthly
    }
  }

  const conditional = consolidationOpportunities(subs, { excludeIds: strongDuplicateIds })
    .reduce((sum, op) => sum + op.monthly, 0)

  const inactivity = subs
    .filter((s) => INACTIVITY_STATUSES.has(s.status))
    .reduce((sum, s) => sum + (monthlyEquivalent(s.amount, s.billingInterval) || 0), 0)

  const priceIncrease = subs.reduce((sum, s) => sum + (priceIncreaseImpact(s)?.monthly || 0), 0)

  const duplicateExposureTotal = round2(strong)
  const breakdown = {
    duplicateExposure: duplicateExposureTotal,
    suspectedDuplicateExposure: round2(suspected),
    conditionalSavings: round2(conditional),
    inactivityReviewAmount: round2(inactivity),
    priceIncreaseImpact: round2(priceIncrease),
    // Backward-compatible aliases for existing API consumers (same values as above).
    confirmedSavings: duplicateExposureTotal,
    suspectedDuplicateSavings: round2(suspected),
    /** @deprecated Not a saving and not part of potentialSavings; use inactivityReviewAmount. */
    inactivitySavings: round2(inactivity),
    includedInTotal: ['duplicateExposure', 'conditionalSavings'],
    excludedFromTotal: ['suspectedDuplicateExposure', 'inactivityReviewAmount', 'priceIncreaseImpact'],
    formula: SAVINGS_FORMULA,
    explanation: SAVINGS_EXPLANATION,
  }
  return { potentialSavings: round2(strong + conditional), breakdown }
}
