// Tracking tests for KNOWN, UNRESOLVED issues (documented in ml-service/docs/PHASE_3_3_INTEGRATION.md).
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
import { analyzeMerchantRecurrence, detectServiceOverlaps } from '../src/services/detectionService.js'

const FAKE = Boolean(mongoose.__isFake)

async function kpis() {
  let body
  await getKpis({}, { json: (b) => { body = b } })
  return body
}

const baseSub = (over) => ({
  name: over.slug, category: 'Cloud', amount: 100, billingInterval: 'monthly',
  nextBillingDate: new Date('2026-01-01'), status: 'active', ...over,
})

test('KPIs expose the Phase 3.3 anomalyAlerts count', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  await Alert.create({ type: 'payment_anomaly', title: 't', description: 'd', impact: 'i', impactLabel: 'l', anomalyKey: 'k' })
  await Alert.create({ type: 'price_increase', title: 't', description: 'd', impact: 'i', impactLabel: 'l' })
  const body = await kpis()
  assert.equal(body.anomalyAlerts, 1)
  assert.equal(body.alertCount, 2)
})

test('KNOWN ISSUE 1a: yearly duplicate charges are added to monthly savings without /12',
  { todo: 'analyticsController.getKpis uses duplicateAmount (a yearly charge) in a monthly total' }, async (t) => {
    if (!FAKE) return t.skip('requires the in-memory fake database')
    mongoose.__resetAll()
    await Subscription.create(baseSub({ slug: 'dropbox', amount: 9900, billingInterval: 'yearly',
      hasDuplicateCharges: true, duplicateAmount: 9900, duplicateConfidence: 'high' }))
    const body = await kpis()
    assert.equal(body.savingsBreakdown.confirmedSavings, 825)
  })

test('KNOWN ISSUE 1b: a subscription can be counted in both overlap and inactivity savings tiers',
  { todo: 'getKpis passes inactive subscriptions to detectServiceOverlaps (double counting)' }, async (t) => {
    if (!FAKE) return t.skip('requires the in-memory fake database')
    mongoose.__resetAll()
    await Subscription.create(baseSub({ slug: 'netflix', amount: 649, serviceDomain: 'video_streaming' }))
    await Subscription.create(baseSub({ slug: 'prime', amount: 299, serviceDomain: 'video_streaming',
      status: 'potentially_inactive' }))
    const body = await kpis()
    // Prime (₹299) should be counted once, not as both "inactive" and "overlap" savings.
    assert.equal(body.potentialSavings, 299)
  })

test('KNOWN ISSUE 1c: confirmed_cancelled subscriptions still produce service-overlap savings',
  { todo: "detectServiceOverlaps filters status 'cancelled', but the enum value is 'confirmed_cancelled'" }, () => {
    const overlaps = detectServiceOverlaps([
      { slug: 'netflix', name: 'Netflix', amount: 649, serviceDomain: 'video_streaming', status: 'active' },
      { slug: 'prime', name: 'Prime', amount: 299, serviceDomain: 'video_streaming', status: 'confirmed_cancelled' },
    ])
    assert.equal(overlaps.length, 0)
  })

test('KNOWN ISSUE 2: CSV import drops identical rows that have no reference id',
  { todo: 'transactionController.importTransactions de-duplicates by date|merchant|amount|account within the CSV' },
  async (t) => {
    if (!FAKE) return t.skip('requires the in-memory fake database')
    let importTransactions
    try {
      ;({ importTransactions } = await import('../src/controllers/transactionController.js'))
    } catch (err) {
      return t.skip(`transactionController needs csv-parse (npm install): ${err.message}`)
    }
    mongoose.__resetAll()
    const csv = 'date,merchant,amount,account\n2026-08-14,STARBUCKS COFFEE,350,HDFC\n2026-08-14,STARBUCKS COFFEE,350,HDFC\n'
    let status
    let body
    await importTransactions({ file: { buffer: Buffer.from(csv) } },
      { status(s) { status = s; return this }, json(b) { body = b } })
    assert.equal(status, 201)
    assert.equal(body.count, 2, 'two legitimate identical purchases should both be kept (or flagged), not silently dropped')
  })

test('KNOWN ISSUE 3: month-end subscriptions whose charge posts on the 1st are not detected',
  { todo: 'analyzeMerchantRecurrence keeps only the last charge per calendar month' }, () => {
    const dates = ['2025-01-30', '2025-03-01', '2025-03-30', '2025-04-30', '2025-06-01', '2025-06-30', '2025-07-30']
    const txs = dates.map((d) => ({ date: new Date(`${d}T00:00:00Z`), amount: 499 }))
    const r = analyzeMerchantRecurrence(txs, 'Month End Plan', 'Software', '2025-08-05')
    assert.ok(r, 'a regular ~30-day plan should be detected')
  })

test('FIXED in Phase 3.3: Alert severity "info" is accepted (see alertSeverity.test.js)', async (t) => {
  if (!FAKE) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  const a = await Alert.create({ type: 'inactivity_review', severity: 'info', title: 't', description: 'd', impact: 'i', impactLabel: 'l' })
  assert.equal(a.severity, 'info')
})
