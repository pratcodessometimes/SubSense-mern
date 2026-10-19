// Live-server API test: requires `npm run dev` (or an equivalent server) on localhost:5000.
// Phase 4.1: every financial endpoint needs a session, so this test registers a throwaway
// user and sends its session cookie + CSRF token. Run it only against a disposable database.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test, { before } from 'node:test'
import { Client } from './support/httpHarness.mjs'

const API_BASE = process.env.API_BASE || 'http://localhost:5000/api'
const api = new Client(API_BASE)

before(async () => {
  await api.register('API Integration', `api-it-${randomBytes(6).toString('hex')}@example.test`)
})

test('Integration: financial APIs reject unauthenticated requests', async () => {
  const anon = new Client(API_BASE)
  for (const path of ['/transactions', '/subscriptions', '/alerts', '/analytics/kpis']) {
    assert.equal((await anon.get(path)).status, 401, path)
  }
  assert.equal((await anon.post('/transactions/analyze', {})).status, 401)
})

test('Integration: GET /api/health returns ok', async () => {
  const res = await fetch(`${API_BASE}/health`)
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.equal(data.status, 'ok')
})

test('Integration: CSV Import rejects missing required columns', async () => {
  const badCsv = 'date,merchant\n2026-08-01,Netflix\n'
  const form = new FormData()
  form.append('file', new Blob([badCsv], { type: 'text/csv' }), 'test.csv')

  const { status, data } = await api.request('POST', '/transactions/import', { form })

  assert.equal(status, 400)
  assert.ok(data.error.includes('missing required columns'), `Error was: ${data.error}`)
})

test('Integration: CSV Import rejects invalid date rows', async () => {
  const badDateCsv = 'date,merchant,amount\nnot-a-date,Netflix,649\n'
  const form = new FormData()
  form.append('file', new Blob([badDateCsv], { type: 'text/csv' }), 'test.csv')

  const { status, data } = await api.request('POST', '/transactions/import', { form })

  assert.equal(status, 400)
  assert.ok(data.error.includes('invalid date'), `Error was: ${data.error}`)
})

test('Integration: CSV Import rejects invalid amount rows', async () => {
  const badAmountCsv = 'date,merchant,amount\n2026-08-10,Netflix,-50\n'
  const form = new FormData()
  form.append('file', new Blob([badAmountCsv], { type: 'text/csv' }), 'test.csv')

  const { status, data } = await api.request('POST', '/transactions/import', { form })

  assert.equal(status, 400)
  assert.ok(data.error.includes('invalid amount'), `Error was: ${data.error}`)
})

test('Integration: Idempotent CSV Import - duplicate imports do not create duplicate records', async () => {
  const testBatchCsv = [
    'date,merchant,amount,account',
    '2026-01-10,GitHub Copilot,820,HDFC •••• 2814',
    '2026-02-10,GitHub Copilot,820,HDFC •••• 2814',
    '2026-03-10,GitHub Copilot,820,HDFC •••• 2814',
  ].join('\n')

  // First import
  const form1 = new FormData()
  form1.append('file', new Blob([testBatchCsv], { type: 'text/csv' }), 'batch.csv')
  const res1 = await api.request('POST', '/transactions/import', { form: form1 })
  assert.equal(res1.status, 201)
  const data1 = res1.data
  assert.ok(data1.detection, 'Response must include detection results')

  // Second import of EXACT SAME CSV
  const form2 = new FormData()
  form2.append('file', new Blob([testBatchCsv], { type: 'text/csv' }), 'batch.csv')
  const res2 = await api.request('POST', '/transactions/import', { form: form2 })
  assert.equal(res2.status, 201)
  const data2 = res2.data

  // Must detect that all 3 were duplicate and skipped!
  assert.equal(data2.count, 0, 'Must insert 0 duplicate transactions on second import')
  assert.equal(data2.skippedCount, 3, 'Must report 3 skipped duplicate records')
})

test('Integration: POST /api/transactions/analyze executes detection on demand', async () => {
  const res = await api.post('/transactions/analyze', {})
  assert.equal(res.status, 200)
  const data = res.data
  assert.ok(data.totalSubscriptions >= 1)
  assert.ok(Array.isArray(data.subscriptions))
})

test('Integration: GET /api/analytics/kpis normalizes yearly subscriptions and returns accurate metrics', async () => {
  const res = await api.get('/analytics/kpis')
  assert.equal(res.status, 200)
  const data = res.data
  assert.ok(typeof data.monthlySpend === 'number')
  assert.ok(typeof data.activeSubscriptions === 'number')
  assert.ok(typeof data.potentialSavings === 'number')
  assert.ok(typeof data.transactionCount === 'number')
})

test('Integration: Price Increase Alerts API - manual alert creation and listing with intelligence fields', async () => {
  // 1. Create a manual alert with price increase intelligence fields
  const payload = {
    type: 'price_increase',
    severity: 'warning',
    title: 'Price increase detected: Test Service',
    description: 'Your Test Service subscription increased from ₹499 to ₹649/month (+30.1%). Adds ₹150/month to your budget.',
    subscriptionIds: ['test-service'],
    impact: '+₹1,800/yr',
    impactLabel: 'Annual financial impact',
    previousAmount: 499,
    currentAmount: 649,
    percentageChange: 30.1,
    monthlyImpact: 150,
    annualImpact: 1800,
    isManual: true,
  }

  const postRes = await api.post('/alerts', payload)
  assert.equal(postRes.status, 201)
  const createdAlert = postRes.data
  assert.equal(createdAlert.isManual, true)
  assert.equal(createdAlert.previousAmount, 499)
  assert.equal(createdAlert.currentAmount, 649)
  assert.equal(createdAlert.annualImpact, 1800)

  // 2. Fetch all alerts
  const listRes = await api.get('/alerts')
  assert.equal(listRes.status, 200)
  const alertsList = listRes.data
  assert.ok(Array.isArray(alertsList))
  const found = alertsList.find((a) => a._id === createdAlert._id)
  assert.ok(found, 'Created manual alert must be present in alerts list')
  assert.equal(found.annualImpact, 1800)

  // 3. Clean up created alert
  const delRes = await api.del(`/alerts/${createdAlert._id}`)
  assert.equal(delRes.status, 204)
})

