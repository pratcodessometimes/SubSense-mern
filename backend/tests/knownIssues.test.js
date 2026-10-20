// Tracking tests for KNOWN issues (documented in ml-service/docs/PHASE_3_3_INTEGRATION.md and
// backend/docs/PHASE_5_1_PRODUCTION_READINESS.md). Fixed issues stay here as regression tests.
// Each `todo` test asserts the CORRECT behaviour. While the bug exists node:test reports
// it as "# todo" instead of a failure, so it stays visible without blocking the suite.
// When someone fixes an issue, the todo test starts passing: remove the `todo` option.
// In-memory fake database only (npm run test:unit).
import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import { getKpis } from '../src/controllers/analyticsController.js'
import { Alert } from '../src/models/Alert.js'
import { Subscription } from '../src/models/Subscription.js'
import { Transaction } from '../src/models/Transaction.js'
import { analyzeMerchantRecurrence, detectServiceOverlaps } from '../src/services/detectionService.js'
import { newTestUserId } from './support/testUsers.mjs'

const FAKE = Boolean(mongoose.__isFake)
const USER = newTestUserId()

async function kpis() {
  let body
  await getKpis({ user: { id: USER } }, { json: (b) => { body = b } })
  return body
}

const baseSub = (over) => ({
  userId: USER,
  name: over.slug, category: 'Cloud', amount: 100, billingInterval: 'monthly',
  nextBillingDate: new Date('2026-01-01'), status: 'active', ...over,
})

test('KPIs expose the Phase 3.3 anomalyAlerts count', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  await Alert.create({ userId: USER, type: 'payment_anomaly', title: 't', description: 'd', impact: 'i', impactLabel: 'l', anomalyKey: 'k' })
  await Alert.create({ userId: USER, type: 'price_increase', title: 't', description: 'd', impact: 'i', impactLabel: 'l' })
  const body = await kpis()
  assert.equal(body.anomalyAlerts, 1)
  assert.equal(body.alertCount, 2)
})

test('FIXED in Phase 4.3 (was KNOWN ISSUE 1a): yearly duplicate charges are normalized to a monthly equivalent', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  await Subscription.create(baseSub({ slug: 'dropbox', amount: 9900, billingInterval: 'yearly',
    hasDuplicateCharges: true, duplicateAmount: 9900, duplicateConfidence: 'high' }))
  const body = await kpis()
  assert.equal(body.savingsBreakdown.confirmedSavings, 825)
  assert.equal(body.savingsBreakdown.duplicateExposure, 825)
  assert.equal(body.potentialSavings, 825)
})

test('FIXED in Phase 4.3 (was KNOWN ISSUE 1b): an inactive subscription is neither an overlap nor a saving', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  await Subscription.create(baseSub({ slug: 'netflix', amount: 649, serviceDomain: 'video_streaming' }))
  await Subscription.create(baseSub({ slug: 'prime', amount: 299, serviceDomain: 'video_streaming',
    status: 'potentially_inactive' }))
  const body = await kpis()
  // Missing payments are a review amount, never a saving, and Prime is not counted twice.
  assert.equal(body.potentialSavings, 0)
  assert.equal(body.savingsBreakdown.conditionalSavings, 0)
  assert.equal(body.savingsBreakdown.inactivityReviewAmount, 299)
})

test('FIXED in Phase 5.1 (was KNOWN ISSUE 1c): confirmed_cancelled subscriptions produce no service overlap', () => {
  const overlaps = detectServiceOverlaps([
    { slug: 'netflix', name: 'Netflix', amount: 649, serviceDomain: 'video_streaming', status: 'active' },
    { slug: 'prime', name: 'Prime', amount: 299, serviceDomain: 'video_streaming', status: 'confirmed_cancelled' },
  ])
  assert.equal(overlaps.length, 0)
  // Two live services in the same domain still overlap.
  const live = detectServiceOverlaps([
    { slug: 'netflix', name: 'Netflix', amount: 649, serviceDomain: 'video_streaming', status: 'active' },
    { slug: 'prime', name: 'Prime', amount: 299, serviceDomain: 'video_streaming', status: 'price_increase' },
  ])
  assert.equal(live.length, 1)
})

test('FIXED in Phase 5.1 (was KNOWN ISSUE 1c): a cancelled service adds no consolidation saving', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  await Subscription.create(baseSub({ slug: 'netflix', amount: 649, serviceDomain: 'video_streaming' }))
  await Subscription.create(baseSub({ slug: 'prime', amount: 299, serviceDomain: 'video_streaming', status: 'confirmed_cancelled' }))
  const body = await kpis()
  assert.equal(body.savingsBreakdown.conditionalSavings, 0)
  assert.equal(body.potentialSavings, 0)
})

async function importCsv(csv, user = USER) {
  const { importTransactions } = await import('../src/controllers/transactionController.js')
  let status
  let body
  await importTransactions({ user: { id: user }, file: { buffer: Buffer.from(csv) } },
    { status(s) { status = s; return this }, json(b) { body = b } })
  return { status, body }
}

test('FIXED in Phase 5.1 (was KNOWN ISSUE 2): identical rows without a reference id are all kept, and re-import stays idempotent', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  const csv = 'date,merchant,amount,account\n2026-08-14,STARBUCKS COFFEE,350,HDFC\n2026-08-14,STARBUCKS COFFEE,350,HDFC\n'
  const first = await importCsv(csv)
  assert.equal(first.status, 201)
  assert.equal(first.body.count, 2, 'two legitimate identical purchases are both kept')
  assert.equal(first.body.identicalRowsKept, 2, 'and reported so the user can check the statement')

  const again = await importCsv(csv)
  assert.equal(again.body.count, 0, 're-importing the same file inserts nothing')
  assert.equal(again.body.skippedCount, 2)

  // An overlapping statement that lists the purchase once adds nothing either.
  const overlap = await importCsv('date,merchant,amount,account\n2026-08-14,STARBUCKS COFFEE,350,HDFC\n2026-08-15,STARBUCKS COFFEE,350,HDFC\n')
  assert.equal(overlap.body.count, 1, 'only the new 15 Aug purchase is added')
  assert.equal((await Transaction.find({ userId: USER })).length, 3)
})

test('Phase 5.1: rows with a bank reference are idempotent on re-import; a repeated reference is one transaction', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  const csv = [
    'date,merchant,amount,account,reference',
    '2026-08-14,STARBUCKS COFFEE,350,HDFC,TXN-1',
    '2026-08-14,STARBUCKS COFFEE,350,HDFC,TXN-2',
    '2026-08-14,STARBUCKS COFFEE,350,HDFC,TXN-2',
  ].join('\n')
  const first = await importCsv(csv)
  assert.equal(first.body.count, 2, 'TXN-1 and TXN-2 are distinct; the repeated TXN-2 row is the same transaction')
  assert.equal(first.body.transactions.find((x) => x.reference === 'TXN-1').notes, 'Ref: TXN-1')
  const again = await importCsv(csv)
  assert.equal(again.body.count, 0, 'before Phase 5.1 every referenced row was inserted again')
  assert.equal((await Transaction.find({ userId: USER })).length, 2)
})

test('Phase 5.1: legacy rows that only carry the reference in notes are still matched on re-import', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  await Transaction.create({ userId: USER, date: new Date('2026-08-14'), merchant: 'STARBUCKS COFFEE', amount: 350, account: 'HDFC', notes: 'Ref: OLD-7' })
  const res = await importCsv('date,merchant,amount,account,ref\n2026-08-14,STARBUCKS COFFEE,350,HDFC,OLD-7\n')
  assert.equal(res.body.count, 0)
})

test('Phase 5.1: CSV headers that could replace the record prototype are rejected', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  for (const header of ['__proto__', 'constructor', ' Prototype ']) {
    const res = await importCsv(`date,merchant,amount,${header}\n2026-08-14,X,1,y\n`)
    assert.equal(res.status, 400, header)
    assert.match(res.body.error, /not allowed/)
  }
  assert.equal((await Transaction.find({ userId: USER })).length, 0)
})

test('FIXED in Phase 5.1 (was KNOWN ISSUE 3): month-end subscriptions whose charge posts on the 1st are detected', () => {
  const dates = ['2025-01-30', '2025-03-01', '2025-03-30', '2025-04-30', '2025-06-01', '2025-06-30', '2025-07-30']
  const txs = dates.map((d) => ({ date: new Date(`${d}T00:00:00Z`), amount: 499 }))
  const r = analyzeMerchantRecurrence(txs, 'Month End Plan', 'Software', '2025-08-05')
  assert.ok(r, 'a regular ~30-day plan should be detected')
  assert.equal(r.billingInterval, 'monthly')
  assert.equal(r.status, 'active')
  // March and June each hold two consecutive cycles; that is NOT duplicate billing.
  assert.equal(r.hasDuplicateCharges, false)
  assert.equal(r.transactionCount, 7)
})

test('Phase 5.1: the month-end fallback still recognises a genuine same-cycle duplicate', () => {
  const dates = ['2025-01-30', '2025-03-01', '2025-03-30', '2025-04-30', '2025-06-01', '2025-06-30', '2025-07-30']
  const txs = dates.map((d) => ({ date: new Date(`${d}T00:00:00Z`), amount: 499, account: 'HDFC' }))
  txs.push({ date: new Date('2025-07-31T00:00:00Z'), amount: 499, account: 'ICICI' })
  const r = analyzeMerchantRecurrence(txs, 'Month End Plan', 'Software', '2025-08-05')
  assert.ok(r)
  assert.equal(r.hasDuplicateCharges, true)
})

test('Phase 5.1: the month-end fallback does not turn irregular spending into a subscription', () => {
  // Purchases roughly every 3-6 weeks with no stable cycle.
  const dates = ['2025-01-02', '2025-02-20', '2025-03-01', '2025-04-25', '2025-05-02', '2025-06-30']
  const txs = dates.map((d) => ({ date: new Date(`${d}T00:00:00Z`), amount: 499 }))
  assert.equal(analyzeMerchantRecurrence(txs, 'Irregular Shop', 'Shopping', '2025-07-05'), null)
})

test('KNOWN ISSUE 4 (found in Phase 5.1): frequent identical purchases read as a monthly duplicate-billed subscription',
  { todo: 'calendar-month grouping keeps the last purchase of each month; every-2-days coffee then looks monthly + duplicated' }, () => {
    const coffee = Array.from({ length: 60 }, (_, k) => ({ date: new Date(Date.UTC(2025, 0, 1 + k * 2)), amount: 350 }))
    assert.equal(analyzeMerchantRecurrence(coffee, 'Coffee', 'Food', '2025-05-01'), null)
  })

test('FIXED in Phase 3.3: Alert severity "info" is accepted (see alertSeverity.test.js)', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  const a = await Alert.create({ userId: USER, type: 'inactivity_review', severity: 'info', title: 't', description: 'd', impact: 'i', impactLabel: 'l' })
  assert.equal(a.severity, 'info')
})
