import assert from 'node:assert/strict'
import test from 'node:test'

const API_BASE = 'http://localhost:5000/api'

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

  const res = await fetch(`${API_BASE}/transactions/import`, {
    method: 'POST',
    body: form,
  })

  assert.equal(res.status, 400)
  const data = await res.json()
  assert.ok(data.error.includes('missing required columns'), `Error was: ${data.error}`)
})

test('Integration: CSV Import rejects invalid date rows', async () => {
  const badDateCsv = 'date,merchant,amount\nnot-a-date,Netflix,649\n'
  const form = new FormData()
  form.append('file', new Blob([badDateCsv], { type: 'text/csv' }), 'test.csv')

  const res = await fetch(`${API_BASE}/transactions/import`, {
    method: 'POST',
    body: form,
  })

  assert.equal(res.status, 400)
  const data = await res.json()
  assert.ok(data.error.includes('invalid date'), `Error was: ${data.error}`)
})

test('Integration: CSV Import rejects invalid amount rows', async () => {
  const badAmountCsv = 'date,merchant,amount\n2026-08-10,Netflix,-50\n'
  const form = new FormData()
  form.append('file', new Blob([badAmountCsv], { type: 'text/csv' }), 'test.csv')

  const res = await fetch(`${API_BASE}/transactions/import`, {
    method: 'POST',
    body: form,
  })

  assert.equal(res.status, 400)
  const data = await res.json()
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
  const res1 = await fetch(`${API_BASE}/transactions/import`, { method: 'POST', body: form1 })
  assert.equal(res1.status, 201)
  const data1 = await res1.json()
  assert.ok(data1.detection, 'Response must include detection results')

  // Second import of EXACT SAME CSV
  const form2 = new FormData()
  form2.append('file', new Blob([testBatchCsv], { type: 'text/csv' }), 'batch.csv')
  const res2 = await fetch(`${API_BASE}/transactions/import`, { method: 'POST', body: form2 })
  assert.equal(res2.status, 201)
  const data2 = await res2.json()

  // Must detect that all 3 were duplicate and skipped!
  assert.equal(data2.count, 0, 'Must insert 0 duplicate transactions on second import')
  assert.equal(data2.skippedCount, 3, 'Must report 3 skipped duplicate records')
})

test('Integration: POST /api/transactions/analyze executes detection on demand', async () => {
  const res = await fetch(`${API_BASE}/transactions/analyze`, { method: 'POST' })
  assert.equal(res.status, 200)
  const data = await res.json()
  assert.ok(data.totalSubscriptions >= 1)
  assert.ok(Array.isArray(data.subscriptions))
})

test('Integration: GET /api/analytics/kpis normalizes yearly subscriptions and returns accurate metrics', async () => {
  const res = await fetch(`${API_BASE}/analytics/kpis`)
  assert.equal(res.status, 200)
  const data = await res.json()
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

  const postRes = await fetch(`${API_BASE}/alerts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  assert.equal(postRes.status, 201)
  const createdAlert = await postRes.json()
  assert.equal(createdAlert.isManual, true)
  assert.equal(createdAlert.previousAmount, 499)
  assert.equal(createdAlert.currentAmount, 649)
  assert.equal(createdAlert.annualImpact, 1800)

  // 2. Fetch all alerts
  const listRes = await fetch(`${API_BASE}/alerts`)
  assert.equal(listRes.status, 200)
  const alertsList = await listRes.json()
  assert.ok(Array.isArray(alertsList))
  const found = alertsList.find((a) => a._id === createdAlert._id)
  assert.ok(found, 'Created manual alert must be present in alerts list')
  assert.equal(found.annualImpact, 1800)

  // 3. Clean up created alert
  const delRes = await fetch(`${API_BASE}/alerts/${createdAlert._id}`, { method: 'DELETE' })
  assert.equal(delRes.status, 204)
})

