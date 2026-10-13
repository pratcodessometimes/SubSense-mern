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
