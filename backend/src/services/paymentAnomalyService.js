/**
 * Payment Anomaly Service (Phase 3.3)
 *
 * Node.js port of the robust, explainable deviation detector whose reference
 * implementation is ml-service/subsense_ml/anomaly.py::score_sequence.
 * Parity is enforced by backend/tests/paymentAnomaly.test.js against
 * backend/tests/fixtures/anomaly_parity.json (exported from Python).
 *
 * For each payment of ONE recurring group it looks only at the previous
 * WINDOW payments (never the payment itself or later ones) and computes robust
 * z-scores for the amount and for the gap since the previous payment:
 *
 *     z = (value - median) / max(1.4826 * MAD, floor)
 *
 * The floors handle zero MAD (perfectly constant history) so a ₹1 change on a
 * constant ₹499 plan is not "infinitely" unusual. |z| > 3.5 is flagged, and
 * every flag carries a plain-language reason in both directions
 * (higher / lower amount, earlier-or-duplicate / later payment).
 *
 * This is NOT the synthetic-trained classifier from Phase 3.2; that model stays
 * experimental and is not used by the application.
 */

export const ANOMALY_CONFIG = Object.freeze({
  window: 6,
  minHistory: 3,
  zThreshold: 3.5,
  madToStd: 1.4826,
  amountFloorRel: 0.02,
  intervalFloorDays: 2,
  intervalFloorRel: 0.05,
  version: 'robust-mad-v1',
})

const DAY_MS = 24 * 60 * 60 * 1000

/** UTC calendar-day number (days since 1970-01-01), or null for invalid input. */
export function toUtcDayNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  const t = d.getTime()
  if (!Number.isFinite(t)) return null
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / DAY_MS)
}

export function dayNumberToIso(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10)
}

function median(values) {
  const s = [...values].sort((a, b) => a - b)
  const n = s.length
  if (n === 0) return NaN
  const mid = Math.floor(n / 2)
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Pure scoring of an already sorted sequence (mirrors Python score_sequence).
 * @param {number[]} dayNumbers ascending UTC day numbers
 * @param {number[]} amounts positive amounts
 */
export function scoreSequence(dayNumbers, amounts, config = ANOMALY_CONFIG) {
  const out = []
  for (let i = config.minHistory; i < amounts.length; i++) {
    const lo = Math.max(0, i - config.window)
    const wAmt = amounts.slice(lo, i)
    const wDays = dayNumbers.slice(lo, i)

    const medA = median(wAmt)
    const madA = median(wAmt.map((a) => Math.abs(a - medA)))
    const scaleA = Math.max(config.madToStd * madA, config.amountFloorRel * medA, 1e-9)
    const amountZ = (amounts[i] - medA) / scaleA

    const wInt = []
    for (let k = 1; k < wDays.length; k++) wInt.push(wDays[k] - wDays[k - 1])
    const curInt = dayNumbers[i] - dayNumbers[i - 1]
    const medI = median(wInt)
    const madI = median(wInt.map((v) => Math.abs(v - medI)))
    const scaleI = Math.max(config.madToStd * madI, config.intervalFloorDays, config.intervalFloorRel * medI)
    const intervalZ = (curInt - medI) / scaleI

    const score = Math.max(Math.abs(amountZ), Math.abs(intervalZ))
    let reason = ''
    if (score > config.zThreshold) {
      if (Math.abs(amountZ) >= Math.abs(intervalZ)) {
        reason = amountZ > 0 ? 'amount_higher_than_usual' : 'amount_lower_than_usual'
      } else {
        reason = intervalZ < 0 ? 'paid_earlier_than_usual_or_duplicate' : 'paid_later_than_usual'
      }
    }
    out.push({
      index: i,
      historyUsed: i - lo,
      refMedianAmount: medA,
      refMedianInterval: medI,
      intervalDays: curInt,
      amountZ,
      intervalZ,
      score,
      isAnomaly: score > config.zThreshold,
      reason,
    })
  }
  return out
}

/**
 * Validate, sort and score a group's raw transactions.
 * @param {Array<{ _id?: any, date: any, amount: any, account?: string }>} transactions
 * @returns {{ status: 'scored'|'insufficient_history', validCount: number, skippedInvalid: number, payments: object[] }}
 */
export function scorePaymentHistory(transactions, config = ANOMALY_CONFIG) {
  const valid = []
  let skippedInvalid = 0
  ;(transactions || []).forEach((t, order) => {
    const day = toUtcDayNumber(t && t.date)
    const amount = Number(t && t.amount)
    if (day === null || !Number.isFinite(amount) || amount <= 0) {
      skippedInvalid++
      return
    }
    valid.push({ day, amount, order, id: t._id !== undefined && t._id !== null ? String(t._id) : null, account: t.account })
  })
  // Stable: same-day payments keep their input order (the later one is the "repeat").
  valid.sort((a, b) => a.day - b.day || a.order - b.order)

  if (valid.length < config.minHistory + 1) {
    return { status: 'insufficient_history', validCount: valid.length, skippedInvalid, payments: [] }
  }

  const scored = scoreSequence(valid.map((v) => v.day), valid.map((v) => v.amount), config)
  const payments = scored.map((s) => {
    const v = valid[s.index]
    return {
      ...s,
      transactionId: v.id,
      account: v.account,
      day: v.day,
      date: dayNumberToIso(v.day),
      amount: v.amount,
    }
  })
  return { status: 'scored', validCount: valid.length, skippedInvalid, payments }
}

/** Human-readable explanation used in alert descriptions. */
export function describeAnomaly(p, name) {
  const fmt = (n) => `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  const pct = p.refMedianAmount > 0 ? Math.round(((p.amount - p.refMedianAmount) / p.refMedianAmount) * 1000) / 10 : 0
  switch (p.reason) {
    case 'amount_higher_than_usual':
      return `${name} charged ${fmt(p.amount)} on ${p.date}, ${pct}% above its usual ${fmt(p.refMedianAmount)} (median of the previous ${p.historyUsed} payments).`
    case 'amount_lower_than_usual':
      return `${name} charged ${fmt(p.amount)} on ${p.date}, ${Math.abs(pct)}% below its usual ${fmt(p.refMedianAmount)} (median of the previous ${p.historyUsed} payments). Check for a plan downgrade, partial refund or proration.`
    case 'paid_earlier_than_usual_or_duplicate':
      return `${name} was charged on ${p.date}, only ${p.intervalDays} day(s) after the previous payment; it is usually charged every ~${Math.round(p.refMedianInterval)} days.`
    case 'paid_later_than_usual':
      return `${name} was charged on ${p.date}, ${p.intervalDays} days after the previous payment; it is usually charged every ~${Math.round(p.refMedianInterval)} days.`
    default:
      return `${name} payment on ${p.date} looks unusual.`
  }
}
