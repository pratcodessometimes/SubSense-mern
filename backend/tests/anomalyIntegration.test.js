// Phase 3.3 integrated flow: Transaction -> rule-based detection -> Phase 2 alerts
// -> payment-anomaly alerts. Uses the in-memory fake database ONLY
// (npm run test:unit); skips itself if the real mongoose package is loaded.
import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import { Alert } from '../src/models/Alert.js'
import { Subscription } from '../src/models/Subscription.js'
import { Transaction } from '../src/models/Transaction.js'
import {
  buildAnomalyAlertDoc,
  classifyAnomaly,
  runPaymentAnomalyDetection,
  upsertAnomalyAlert,
} from '../src/services/anomalyAlertService.js'
import { runSubscriptionDetection } from '../src/services/detectionService.js'
import { scorePaymentHistory, toUtcDayNumber } from '../src/services/paymentAnomalyService.js'

const FAKE = Boolean(mongoose.__isFake)
const d = (iso) => new Date(`${iso}T00:00:00.000Z`)

function monthlyDates(year, month, day, n) {
  return Array.from({ length: n }, (_, k) => {
    const dt = new Date(Date.UTC(year, month - 1 + k, day))
    return dt.toISOString().slice(0, 10)
  })
}

async function seedScenario() {
  const rows = []
  const add = (date, merchant, amount, account = 'HDFC 1111') => rows.push({ date: d(date), merchant, amount, account })
  // A) Cult.fit: steady ₹1000 on the 10th, one ₹1100 charge in Nov (a one-off 10% overcharge)
  monthlyDates(2025, 1, 10, 12).forEach((dt) => add(dt, 'CULT.FIT MEMBERSHIP', dt === '2025-11-10' ? 1100 : 1000))
  // C) Netflix: ₹499 Apr-Sep, genuine price rise to ₹649 from Oct (Phase 2 price_increase)
  monthlyDates(2025, 4, 14, 9).forEach((dt, k) => add(dt, 'POS DEBIT - NETFLIX.COM', k < 6 ? 499 : 649))
  // D) Spotify: ₹119 monthly + the same charge again the next day on another card (Phase 2 duplicate)
  monthlyDates(2025, 6, 8, 7).forEach((dt) => add(dt, 'UPI/SPOTIFY AB/4028', 119))
  add('2025-12-09', 'UPI/SPOTIFY AB/4028', 119, 'ICICI 2222')
  // E) Slack: monthly on the 3rd, but December charged 13 days late
  monthlyDates(2025, 1, 3, 11).forEach((dt) => add(dt, 'SLACK TECHNOLOGIES', 700))
  add('2025-12-16', 'SLACK TECHNOLOGIES', 700)
  // F) AWS: only 3 payments -> detected by rules, insufficient history for anomaly scoring
  monthlyDates(2025, 10, 5, 3).forEach((dt) => add(dt, 'AMAZON WEB SERVICES', 820))
  // noise: irregular spend (not a subscription)
  ;[['2025-11-02', 300], ['2025-11-09', 820], ['2025-12-01', 150]].forEach(([dt, a]) => add(dt, 'SWIGGY BANGALORE', a))
  await Transaction.insertMany(rows)
}

const anomalyAlerts = async () => (await Alert.find({ type: 'payment_anomaly' })).sort((a, b) => a.anomalyKey.localeCompare(b.anomalyKey))

test('Integrated flow: anomaly alerts are created, de-duplicated against Phase 2, idempotent and reconciled', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database (npm run test:unit)')
  mongoose.__resetAll()
  await seedScenario()
  const manual = await Alert.create({
    type: 'payment_anomaly', title: 'Manual note', description: 'user note', impact: '-', impactLabel: '-',
    subscriptionIds: ['cult-fit'], isManual: true,
  })

  // ---- Run 1 ---------------------------------------------------------------
  const r1 = await runSubscriptionDetection('2025-12-20')
  const slugs = r1.subscriptions.map((s) => s.slug).sort()
  assert.deepEqual(slugs, ['aws', 'cult-fit', 'netflix', 'slack', 'spotify'], 'rule engine stays the subscription detector')
  const ad = r1.anomalyDetection
  assert.equal(ad.status, 'completed')
  assert.equal(ad.evaluatedSubscriptions, 5)
  assert.equal(ad.insufficientHistory, 1, 'AWS has only 3 payments')
  assert.ok(ad.suppressed.covered_by_price_increase_alert >= 2, JSON.stringify(ad.suppressed))
  assert.equal(ad.suppressed.covered_by_duplicate_charge_alert, 1)
  assert.equal(ad.alerts.created, 2)

  const a1 = await anomalyAlerts()
  const auto1 = a1.filter((a) => !a.isManual)
  assert.equal(auto1.length, 2)
  const cult = auto1.find((a) => a.subscriptionIds[0] === 'cult-fit')
  assert.equal(cult.subType, 'unusual_amount')
  assert.equal(cult.anomalyReason, 'amount_higher_than_usual')
  assert.equal(cult.currentAmount, 1100)
  assert.equal(cult.expectedAmount, 1000)
  assert.equal(cult.percentageChange, 10)
  assert.match(cult.description, /10% above its usual ₹1,000/)
  const slack = auto1.find((a) => a.subscriptionIds[0] === 'slack')
  assert.equal(slack.subType, 'unusual_timing')
  assert.equal(slack.anomalyReason, 'paid_later_than_usual')
  assert.equal(slack.actualIntervalDays, 43)

  // Phase 2 alerts still own price rises and duplicates; no anomaly alert repeats them
  assert.equal((await Alert.find({ type: 'price_increase', subscriptionIds: 'netflix' })).length, 1)
  assert.equal((await Alert.find({ type: 'duplicate', subscriptionIds: 'spotify' })).length, 1)
  assert.equal(auto1.filter((a) => ['netflix', 'spotify', 'aws'].includes(a.subscriptionIds[0])).length, 0)

  // ---- Run 2: identical input -> identical alerts (same ids, no new rows) ----
  const totalBefore = await Alert.countDocuments()
  const r2 = await runSubscriptionDetection('2025-12-20')
  assert.equal(r2.anomalyDetection.alerts.created, 0)
  assert.equal(r2.anomalyDetection.alerts.updated, 2)
  assert.equal(await Alert.countDocuments(), totalBefore)
  const a2 = (await anomalyAlerts()).filter((a) => !a.isManual)
  assert.deepEqual(a2.map((a) => a._id), auto1.map((a) => a._id), 'Phase 2 cleanup must not delete/recreate anomaly alerts')
  assert.deepEqual(a2.map((a) => a.createdAt.getTime()), auto1.map((a) => a.createdAt.getTime()))

  // ---- Run 3: two normal months later -> old anomalies age out and are removed ----
  const more = []
  for (const [m, day] of [[1, 10], [2, 10]]) more.push({ date: d(`2026-0${m}-${day}`), merchant: 'CULT.FIT MEMBERSHIP', amount: 1000, account: 'HDFC 1111' })
  for (const m of [1, 2]) {
    more.push({ date: d(`2026-0${m}-16`), merchant: 'SLACK TECHNOLOGIES', amount: 700, account: 'HDFC 1111' })
    more.push({ date: d(`2026-0${m}-14`), merchant: 'POS DEBIT - NETFLIX.COM', amount: 649, account: 'HDFC 1111' })
    more.push({ date: d(`2026-0${m}-08`), merchant: 'UPI/SPOTIFY AB/4028', amount: 119, account: 'HDFC 1111' })
    more.push({ date: d(`2026-0${m}-05`), merchant: 'AMAZON WEB SERVICES', amount: 820, account: 'HDFC 1111' })
  }
  await Transaction.insertMany(more)
  const r3 = await runSubscriptionDetection('2026-02-20')
  assert.equal(r3.anomalyDetection.status, 'completed')
  assert.equal(r3.anomalyDetection.alerts.removed, 2)
  const a3 = await anomalyAlerts()
  assert.deepEqual(a3.map((a) => String(a._id)), [String(manual._id)], 'only the manual alert remains')
})

test('Failure isolation: anomaly step failure never breaks rule-based detection', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  await seedScenario()
  const original = Alert.findOneAndUpdate
  Alert.findOneAndUpdate = async () => {
    throw new Error('simulated database outage')
  }
  const errors = []
  const origErr = console.error
  console.error = (...a) => errors.push(a.join(' '))
  try {
    const r = await runSubscriptionDetection('2025-12-20')
    assert.equal(r.anomalyDetection.status, 'failed')
    assert.equal(r.subscriptions.length, 5)
    assert.equal((await Subscription.find()).length, 5)
    assert.equal((await Alert.find({ type: 'price_increase' })).length, 1)
  } finally {
    Alert.findOneAndUpdate = original
    console.error = origErr
  }
  assert.ok(errors.some((e) => e.includes('simulated database outage')))
})

test('Feature flag: ANOMALY_DETECTION_ENABLED=false disables only the anomaly step', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  await seedScenario()
  process.env.ANOMALY_DETECTION_ENABLED = 'false'
  try {
    const r = await runSubscriptionDetection('2025-12-20')
    assert.equal(r.anomalyDetection.status, 'disabled')
    assert.equal((await Alert.find({ type: 'payment_anomaly' })).length, 0)
    assert.equal((await Alert.find({ type: 'price_increase' })).length, 1)
  } finally {
    delete process.env.ANOMALY_DETECTION_ENABLED
  }
})

test('No transactions: detection reports the anomaly step as skipped', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  const r = await runSubscriptionDetection('2025-12-20')
  assert.equal(r.anomalyDetection.status, 'skipped_no_transactions')
})

// ---- unit-level safeguards ---------------------------------------------------
const ref = toUtcDayNumber('2025-12-20')
const flagged = (over) => ({
  isAnomaly: true, day: toUtcDayNumber('2025-12-10'), date: '2025-12-10', amount: 119, refMedianAmount: 119,
  refMedianInterval: 30.5, intervalDays: 1, score: 15, historyUsed: 6, reason: 'paid_earlier_than_usual_or_duplicate',
  transactionId: 'tx1', ...over,
})

test('Timing alerts are suppressed only with duplicate evidence', () => {
  const sub = { slug: 's', billingInterval: 'monthly', hasDuplicateCharges: true }
  assert.equal(classifyAnomaly(flagged(), sub, ref).because, 'covered_by_duplicate_charge_alert')
  assert.equal(classifyAnomaly(flagged(), { ...sub, hasDuplicateCharges: false }, ref).action, 'alert')
  assert.equal(classifyAnomaly(flagged({ intervalDays: 25 }), sub, ref).action, 'alert', 'gap outside duplicate window')
  assert.equal(classifyAnomaly(flagged({ amount: 199 }), sub, ref).action, 'alert', 'amount differs from usual by >15%')
  assert.equal(classifyAnomaly(flagged({ reason: 'paid_later_than_usual', intervalDays: 45 }), sub, ref).action, 'alert')
})

test('Amount alerts: price-increase coverage only for the new tier on/after the increase date', () => {
  const sub = { slug: 'n', billingInterval: 'monthly', amount: 649, previousAmount: 499, priceIncreaseDate: d('2025-10-14') }
  const up = flagged({ reason: 'amount_higher_than_usual', amount: 649, refMedianAmount: 499, intervalDays: 30 })
  assert.equal(classifyAnomaly(up, sub, ref).because, 'covered_by_price_increase_alert')
  assert.equal(classifyAnomaly({ ...up, amount: 999 }, sub, ref).action, 'alert', 'spike above the new price')
  assert.equal(classifyAnomaly(up, { ...sub, previousAmount: undefined }, ref).action, 'alert', 'no Phase 2 increase')
  const down = flagged({ reason: 'amount_lower_than_usual', amount: 99, refMedianAmount: 499, intervalDays: 30 })
  assert.equal(classifyAnomaly(down, sub, ref).action, 'alert', 'decreases are never covered by Phase 2')
})

test('Only recent payments can raise alerts (1.5 billing intervals)', () => {
  const sub = { slug: 's', billingInterval: 'monthly' }
  assert.equal(classifyAnomaly(flagged({ day: ref - 45 }), sub, ref).action, 'alert')
  assert.equal(classifyAnomaly(flagged({ day: ref - 46 }), sub, ref).because, 'outside_recent_window')
  assert.equal(classifyAnomaly(flagged({ day: ref + 1 }), sub, ref).because, 'outside_recent_window')
  assert.equal(classifyAnomaly(flagged({ day: ref - 500 }), { ...sub, billingInterval: 'yearly' }, ref).action, 'alert')
})

test('Idempotent upsert: duplicate-key race is retried as an update; manual alerts are skipped', async () => {
  const doc = buildAnomalyAlertDoc({ slug: 'slack', name: 'Slack' },
    { ...flagged({ reason: 'paid_later_than_usual', intervalDays: 43 }), amount: 700, refMedianAmount: 700 })
  assert.equal(doc.anomalyKey, 'payment_anomaly:slack:tx1')
  assert.ok(!Object.values(doc).includes(undefined))

  let calls = 0
  const racing = {
    findOne: async () => null,
    findOneAndUpdate: async () => {
      calls++
      if (calls === 1) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 })
      return { ...doc }
    },
  }
  assert.equal(await upsertAnomalyAlert(racing, doc), 'updated_after_conflict')
  const manualOwner = { findOne: async () => ({ isManual: true }), findOneAndUpdate: async () => assert.fail('must not write') }
  assert.equal(await upsertAnomalyAlert(manualOwner, doc), 'skipped_manual')
  const otherError = { findOne: async () => null, findOneAndUpdate: async () => { throw new Error('boom') } }
  await assert.rejects(upsertAnomalyAlert(otherError, doc), /boom/)
})

test('Unique anomalyKey is enforced by the schema (fake honours the sparse unique index)', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  const base = { type: 'payment_anomaly', title: 't', description: 'd', impact: 'i', impactLabel: 'l' }
  await Alert.create({ ...base, anomalyKey: 'k1' })
  await Alert.create({ ...base })            // sparse: alerts without a key are fine
  await Alert.create({ ...base })
  await assert.rejects(Alert.create({ ...base, anomalyKey: 'k1' }), (e) => e.code === 11000)
})

test('A failing subscription does not block others and keeps its existing alerts', async () => {
  const deleted = []
  const model = {
    findOne: async () => null,
    findOneAndUpdate: async () => ({}),
    deleteMany: async (q) => { deleted.push(q); return { deletedCount: 0 } },
  }
  const txs = monthlyDates(2025, 6, 3, 6).map((dt, k) => ({ _id: `s${k}`, date: d(dt), amount: 700 }))
  txs.push({ _id: 'late', date: d('2025-12-16'), amount: 700 })
  const summary = await runPaymentAnomalyDetection({
    subscriptions: [{ slug: 'broken' }, { slug: 'slack', name: 'Slack', billingInterval: 'monthly' }],
    transactionsBySlug: new Map([['broken', []], ['slack', txs]]),
    referenceDate: '2025-12-20',
    AlertModel: model,
    scorer: (list) => {
      if (list.length === 0) throw new Error('corrupt group')
      return scorePaymentHistory(list)
    },
    logger: { error() {} },
  })
  assert.equal(summary.status, 'completed_with_errors')
  assert.equal(summary.alerts.created, 1)
  assert.deepEqual(deleted[0].subscriptionIds.$in, ['slack'], 'broken subscription excluded from stale removal')
})
