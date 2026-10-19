import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  ANOMALY_CONFIG,
  scorePaymentHistory,
  scoreSequence,
  toUtcDayNumber,
} from '../src/services/paymentAnomalyService.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/anomaly_parity.json', import.meta.url), 'utf8'))

const monthly = (n, amount = 499, start = [2025, 0, 5]) =>
  Array.from({ length: n }, (_, k) => ({
    _id: `t${k}`,
    date: new Date(Date.UTC(start[0], start[1] + k, start[2])),
    amount,
  }))

test('Parity: Node port reproduces every Python reference score in the shared fixture', () => {
  assert.equal(ANOMALY_CONFIG.window, fixture.config.window)
  assert.equal(ANOMALY_CONFIG.minHistory, fixture.config.minHistory)
  assert.equal(ANOMALY_CONFIG.zThreshold, fixture.config.zThreshold)
  assert.equal(ANOMALY_CONFIG.madToStd, fixture.config.madToStd)
  assert.equal(ANOMALY_CONFIG.amountFloorRel, fixture.config.amountFloorRel)
  assert.equal(ANOMALY_CONFIG.intervalFloorDays, fixture.config.intervalFloorDays)
  assert.equal(ANOMALY_CONFIG.intervalFloorRel, fixture.config.intervalFloorRel)

  let compared = 0
  for (const c of fixture.cases) {
    const days = c.payments.map((p) => toUtcDayNumber(p.date))
    const got = scoreSequence(days, c.payments.map((p) => p.amount))
    assert.equal(got.length, c.expected.length, `${c.name}: number of scored payments`)
    c.expected.forEach((e, k) => {
      const g = got[k]
      const where = `${c.name}[${e.index}]`
      assert.equal(g.index, e.index, where)
      assert.equal(g.historyUsed, e.history_used, where)
      for (const [js, py] of [['refMedianAmount', 'ref_median_amount'], ['refMedianInterval', 'ref_median_interval'],
        ['intervalDays', 'interval_days'], ['amountZ', 'amount_z'], ['intervalZ', 'interval_z'], ['score', 'robust_score']]) {
        assert.ok(Math.abs(g[js] - e[py]) <= 1e-9 * Math.max(1, Math.abs(e[py])), `${where} ${js}: ${g[js]} vs ${e[py]}`)
      }
      assert.equal(g.isAnomaly, e.robust_flag === 1, `${where} flag`)
      assert.equal(g.reason, e.robust_reason, `${where} reason`)
      compared++
    })
  }
  assert.ok(compared > 300, `compared ${compared} payments`)
})

test('Insufficient history: fewer than minHistory + 1 valid payments are not scored', () => {
  const r = scorePaymentHistory(monthly(3))
  assert.equal(r.status, 'insufficient_history')
  assert.equal(r.payments.length, 0)
  assert.equal(scorePaymentHistory([]).status, 'insufficient_history')
  assert.equal(scorePaymentHistory(null).status, 'insufficient_history')
})

test('Missing or invalid data is skipped and counted, never scored', () => {
  const txs = [...monthly(5), { date: 'not-a-date', amount: 499 }, { date: new Date(), amount: NaN },
    { date: new Date(), amount: -10 }, { date: null, amount: 5 }, { amount: 499 }, { date: new Date(), amount: 0 }]
  const r = scorePaymentHistory(txs)
  assert.equal(r.skippedInvalid, 6)
  assert.equal(r.validCount, 5)
  assert.equal(r.payments.length, 2)
})

test('Zero MAD: a constant history does not flag tiny changes but does flag real spikes and drops', () => {
  const tiny = scorePaymentHistory([...monthly(6), { date: new Date(Date.UTC(2025, 6, 5)), amount: 504 }])
  assert.ok(tiny.payments.every((p) => !p.isAnomaly))
  assert.ok(tiny.payments.every((p) => Number.isFinite(p.score)))

  const up = scorePaymentHistory([...monthly(6), { _id: 'x', date: new Date(Date.UTC(2025, 6, 5)), amount: 1499 }])
  const last = up.payments.at(-1)
  assert.equal(last.reason, 'amount_higher_than_usual')
  assert.equal(last.transactionId, 'x')

  const down = scorePaymentHistory([...monthly(6), { date: new Date(Date.UTC(2025, 6, 5)), amount: 99 }])
  assert.equal(down.payments.at(-1).reason, 'amount_lower_than_usual')
})

test('Timing: same-day repeat is "earlier/duplicate", late payment is "later"', () => {
  const dup = scorePaymentHistory([...monthly(6), { date: new Date(Date.UTC(2025, 5, 5)), amount: 499 }])
  assert.equal(dup.payments.at(-1).reason, 'paid_earlier_than_usual_or_duplicate')
  assert.equal(dup.payments.at(-1).intervalDays, 0)
  const late = scorePaymentHistory([...monthly(6), { date: new Date(Date.UTC(2025, 6, 28)), amount: 499 }])
  assert.equal(late.payments.at(-1).reason, 'paid_later_than_usual')
})

test('Only prior payments are used: adding later payments never changes earlier scores', () => {
  const base = monthly(8).map((t, k) => ({ ...t, amount: [100, 200, 300, 400, 10000, 50, 700, 650][k] }))
  const a = scorePaymentHistory(base).payments
  const b = scorePaymentHistory([...base, { date: new Date(Date.UTC(2025, 8, 5)), amount: 99999 },
    { date: new Date(Date.UTC(2025, 8, 6)), amount: 1 }]).payments.slice(0, a.length)
  assert.deepEqual(b, a)
  // and each score equals the score computed on the truncated history
  a.forEach((p) => {
    const trunc = scorePaymentHistory(base.slice(0, p.index + 1)).payments.at(-1)
    assert.deepEqual(trunc, p)
  })
})

test('Input order does not matter except for same-day ties; dates use UTC days', () => {
  const txs = monthly(7)
  const shuffled = [txs[3], txs[0], txs[6], txs[1], txs[5], txs[2], txs[4]]
  assert.deepEqual(scorePaymentHistory(shuffled), scorePaymentHistory(txs))
  // 23:30 IST on 4 Feb is 18:00 UTC on 4 Feb; 01:00 IST on 5 Feb is still 4 Feb in UTC
  assert.equal(toUtcDayNumber('2026-02-05T01:00:00+05:30'), toUtcDayNumber('2026-02-04'))
})
