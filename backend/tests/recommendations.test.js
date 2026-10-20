// Phase 4.3 recommendation engine, ranking, personalization and financial-integrity tests.
// Pure-function tests use a fixed "now"; HTTP tests run the real Express app on the IN-MEMORY fake
// database (npm run test:unit) and never touch MongoDB Atlas.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, beforeEach, test } from 'node:test'
import mongoose from 'mongoose'
import { Alert } from '../src/models/Alert.js'
import { Session } from '../src/models/Session.js'
import { Subscription } from '../src/models/Subscription.js'
import { Transaction } from '../src/models/Transaction.js'
import { User } from '../src/models/User.js'
import { computeSavingsBreakdown } from '../src/services/financialImpact.js'
import {
  ALERT_PREFERENCE_BY_CATEGORY,
  alertPreferenceKey,
  buildRecommendations,
} from '../src/services/recommendationService.js'
import { Client, startServer } from './support/httpHarness.mjs'

const FAKE = Boolean(mongoose.__isFake)
const skip = !FAKE && 'requires the in-memory fake database (npm run test:unit)'
const NOW = new Date('2025-12-20T00:00:00Z')
const d = (iso) => new Date(`${iso}T00:00:00Z`)

const sub = (over) => ({
  _id: `id-${over.slug}`, name: over.slug, category: 'Software', amount: 100, billingInterval: 'monthly',
  status: 'active', confidence: 0.95, transactionCount: 6, reviewStatus: 'unreviewed',
  nextBillingDate: d('2026-01-14'), lastActivity: d('2025-12-14'), ...over,
})
const anomaly = (over) => ({
  _id: `alert-${over.anomalyKey}`, type: 'payment_anomaly', isManual: false, severity: 'warning',
  title: 't', description: 'd', impact: 'i', impactLabel: 'l', detectorVersion: 'robust-z-v1', ...over,
})
const build = (input) => buildRecommendations({ now: NOW, ...input })
const ids = (out) => out.recommendations.map((r) => r.id)
const text = (r) => JSON.stringify([r.title, r.description, r.explanation, r.evidence, r.action, r.impact])

// ================================================================ generation
test('1. price increase: explains previous, current, % change, monthly and yearly impact', () => {
  const out = build({ subscriptions: [
    sub({ slug: 'netflix', name: 'Netflix', amount: 649, previousAmount: 499, priceIncreaseDate: d('2025-10-14'), status: 'price_increase' }),
    sub({ slug: 'cloud', name: 'Cloud', amount: 1500, previousAmount: 1200, billingInterval: 'yearly', status: 'price_increase' }),
  ] })
  const netflix = out.recommendations.find((r) => r.id === 'price_increase:netflix')
  assert.equal(netflix.title, 'Your Netflix price increased')
  assert.deepEqual(netflix.impact, {
    type: 'additional_cost', monthly: 150, yearly: 1800, label: 'Additional cost from the price increase',
    previousAmount: 499, currentAmount: 649, percentChange: 30.06,
  })
  assert.match(netflix.explanation, /not a saving/)
  const cloud = out.recommendations.find((r) => r.id === 'price_increase:cloud')
  assert.equal(cloud.impact.monthly, 25, 'yearly increase of ₹300 = ₹25/month')
  assert.equal(cloud.impact.yearly, 300)
  assert.equal(out.summary.potentialSavings, 0, 'price increases never become savings')
})

test('2-3. duplicates: strong evidence is a review; suspected is never described as proven', () => {
  const out = build({ subscriptions: [
    sub({ slug: 'spotify', name: 'Spotify', amount: 119, hasDuplicateCharges: true, duplicateAmount: 119, duplicateConfidence: 'high', duplicateAccounts: ['HDFC', 'ICICI'] }),
    sub({ slug: 'gym', name: 'Gym', amount: 999, hasDuplicateCharges: true, duplicateAmount: 999, duplicateConfidence: 'suspected', duplicateAccounts: ['HDFC'] }),
  ] })
  const strong = out.recommendations.find((r) => r.id === 'duplicate_billing:spotify')
  const suspected = out.recommendations.find((r) => r.id === 'duplicate_billing:gym')
  assert.equal(strong.title, 'Review possible duplicate billing for Spotify')
  assert.equal(strong.impact.type, 'potential_duplicate_exposure')
  assert.equal(strong.impact.basis, 'strong')
  assert.equal(suspected.impact.basis, 'suspected')
  assert.equal(suspected.evidenceLevel, 'moderate')
  assert.match(suspected.impact.label, /unverified/)
  for (const r of [strong, suspected]) {
    assert.doesNotMatch(text(r), /fraud|proven|confirmed duplicate|guarantee/i)
    assert.match(r.explanation, /not proof/)
  }
  assert.equal(out.summary.savingsBreakdown.duplicateExposure, 119)
  assert.equal(out.summary.savingsBreakdown.suspectedDuplicateExposure, 999)
  assert.equal(out.summary.potentialSavings, 119, 'suspected exposure is not in the total')
})

test('4. overlaps are conditional, name the assumption and do not assume a service is unnecessary', () => {
  const out = build({ subscriptions: [
    sub({ slug: 'netflix', name: 'Netflix', amount: 649, serviceDomain: 'video_streaming' }),
    sub({ slug: 'prime', name: 'Prime', amount: 1499, billingInterval: 'yearly', serviceDomain: 'video_streaming' }),
  ] })
  const r = out.recommendations.find((x) => x.category === 'service_overlap')
  assert.equal(r.id, 'service_overlap:video_streaming')
  assert.match(r.title, /may overlap/)
  assert.equal(r.impact.type, 'conditional_savings')
  assert.equal(r.impact.monthly, 124.92, 'Prime ₹1499/yr ≈ ₹124.92/month is the consolidation candidate')
  assert.equal(r.impact.yearly, 1499)
  assert.match(r.impact.assumption, /^Only if you keep Netflix and cancel Prime/)
  assert.match(r.explanation, /may well use all of them/)
  assert.deepEqual(r.subscriptionIds, ['netflix', 'prime'])
})

test('5. inactivity: never claims non-usage or savings', () => {
  const out = build({ subscriptions: [
    sub({ slug: 'adobe', name: 'Adobe', amount: 1675, status: 'potentially_inactive', daysOverdue: 48, nextBillingDate: d('2025-11-02'), lastActivity: d('2025-10-02') }),
    sub({ slug: 'aws', name: 'AWS', amount: 820, status: 'needs_review', nextBillingDate: d('2025-11-05') }),
  ] })
  for (const id of ['inactivity_review:adobe', 'inactivity_review:aws']) {
    const r = out.recommendations.find((x) => x.id === id)
    assert.equal(r.impact.type, 'billing_amount_under_review')
    assert.match(r.impact.label, /not a saving/)
    assert.match(r.explanation, /does not mean you stopped using/)
    assert.doesNotMatch(text(r), /unused|you can save|definitely/i)
  }
  assert.equal(out.summary.potentialSavings, 0)
  assert.equal(out.summary.savingsBreakdown.inactivityReviewAmount, 2495)
  assert.equal(out.recommendations.find((x) => x.id === 'inactivity_review:aws').evidenceLevel, 'limited')
})

test('6. payment anomalies keep their reason; scores are never presented as probabilities', () => {
  const reasons = {
    amount_higher_than_usual: /charged more than usual/,
    amount_lower_than_usual: /charged less than usual/,
    paid_earlier_than_usual_or_duplicate: /charged earlier than usual/,
    paid_later_than_usual: /charged later than usual/,
  }
  const alerts = Object.keys(reasons).map((reason, i) => anomaly({
    anomalyKey: `payment_anomaly:slack:tx${i}`, subscriptionIds: ['slack'], anomalyReason: reason, anomalyScore: 6.2,
    currentAmount: reason.startsWith('amount_higher') ? 1100 : reason.startsWith('amount_lower') ? 600 : 1000,
    expectedAmount: 1000, actualIntervalDays: 43, expectedIntervalDays: 30.5, paymentDate: d('2025-12-16'),
  }))
  const out = build({ subscriptions: [sub({ slug: 'slack', name: 'Slack', amount: 1000 })], alerts })
  for (const [reason, pattern] of Object.entries(reasons)) {
    const r = out.recommendations.find((x) => x.anomalyReason === reason)
    assert.ok(r, reason)
    assert.match(r.title, pattern)
    assert.match(r.explanation, /not a confirmed error or fraud/)
    assert.ok(r.evidence.some((e) => /not a probability/.test(e)))
    assert.doesNotMatch(text(r), /\d+(\.\d+)?% (chance|probability|likely)/i)
  }
  const higher = out.recommendations.find((x) => x.anomalyReason === 'amount_higher_than_usual')
  assert.equal(higher.impact.type, 'billing_amount_under_review')
  assert.equal(higher.impact.oneTimeDifference, 100)
  assert.equal(higher.impact.monthly, undefined, 'a one-off difference is not a monthly figure')
  assert.equal(out.recommendations.find((x) => x.anomalyReason === 'paid_later_than_usual').impact.type, 'unquantified')
  assert.deepEqual(higher.sourceAlertIds, ['alert-payment_anomaly:slack:tx0'])
  assert.deepEqual(higher.subscriptionIds, ['slack'], 'links to the subscription')
})

test('7/22. unsupported or unknown amounts are omitted, never fabricated or counted as savings', () => {
  const out = build({
    subscriptions: [
      sub({ slug: 'mystery', name: 'Mystery', amount: 0, status: 'potentially_inactive' }),
      sub({ slug: 'nodup', name: 'NoDup', amount: Number.NaN, hasDuplicateCharges: true, duplicateConfidence: 'high' }),
      sub({ slug: 'badprice', name: 'BadPrice', amount: 500, previousAmount: undefined }),
    ],
    alerts: [anomaly({ anomalyKey: 'k1', subscriptionIds: ['mystery'], anomalyReason: 'amount_higher_than_usual' })],
  })
  const inactive = out.recommendations.find((r) => r.id === 'inactivity_review:mystery')
  assert.deepEqual(inactive.impact, { type: 'unquantified', label: 'Amount not quantified' })
  assert.ok(!ids(out).includes('duplicate_billing:nodup'), 'no amount, no exposure recommendation')
  assert.ok(!ids(out).includes('price_increase:badprice'))
  assert.equal(out.recommendations.find((r) => r.category === 'payment_anomaly').impact.type, 'unquantified')
  for (const r of out.recommendations) {
    for (const v of [r.impact.monthly, r.impact.yearly]) assert.ok(v === undefined || (Number.isFinite(v) && v > 0))
  }
  assert.equal(out.summary.potentialSavings, 0)
})

// ================================================================ ranking & personalization
function rankingFixture() {
  return {
    subscriptions: [
      sub({ slug: 'netflix', name: 'Netflix', amount: 2000, serviceDomain: 'video_streaming' }),
      sub({ slug: 'hotstar', name: 'Hotstar', amount: 1500, serviceDomain: 'video_streaming' }),
      sub({ slug: 'slack', name: 'Slack', amount: 1000 }),
    ],
    alerts: [anomaly({ anomalyKey: 'payment_anomaly:slack:tx9', subscriptionIds: ['slack'], anomalyReason: 'amount_higher_than_usual',
      currentAmount: 1300, expectedAmount: 1000, paymentDate: d('2025-12-10'), anomalyScore: 5 })],
  }
}

test('10. focus changes the order in a meaningful, explainable way', () => {
  const order = (focus) => {
    const out = build({ ...rankingFixture(), preferences: { recommendationFocus: focus } })
    return { ids: ids(out), out }
  }
  const costs = order('reduce_costs')
  const risks = order('billing_risks')
  const pos = (o, id) => o.ids.indexOf(id)
  assert.ok(pos(costs, 'service_overlap:video_streaming') < pos(costs, 'payment_anomaly:payment_anomaly:slack:tx9'),
    `reduce_costs: ${costs.ids}`)
  assert.ok(pos(risks, 'payment_anomaly:payment_anomaly:slack:tx9') < pos(risks, 'service_overlap:video_streaming'),
    `billing_risks: ${risks.ids}`)
  assert.equal(costs.out.meta.focus, 'reduce_costs')
  const overlap = costs.out.recommendations.find((r) => r.category === 'service_overlap')
  assert.ok(overlap.priority.factors.some((f) => f.factor === 'focus' && f.multiplier === 1.5), 'ranking factors are exposed')
  // Focus never changes the facts: same ids, same impacts, same savings totals.
  assert.deepEqual([...costs.ids].sort(), [...risks.ids].sort())
  assert.deepEqual(costs.out.summary.savingsBreakdown, risks.out.summary.savingsBreakdown)
  assert.deepEqual(overlap.impact, risks.out.recommendations.find((r) => r.category === 'service_overlap').impact)
})

test('11-12. ranking is deterministic and ties break by category order, then id', () => {
  const fx = rankingFixture()
  const a = build(fx)
  const b = build({ subscriptions: [...fx.subscriptions].reverse(), alerts: [...fx.alerts].reverse() })
  assert.deepEqual(a, b, 'input order does not matter; identical inputs give identical output')

  const twins = build({ subscriptions: [
    sub({ slug: 'zeta', name: 'Zeta', amount: 600, previousAmount: 500, priceIncreaseDate: d('2025-06-01') }),
    sub({ slug: 'alpha', name: 'Alpha', amount: 600, previousAmount: 500, priceIncreaseDate: d('2025-06-01') }),
  ] })
  const prices = twins.recommendations.filter((r) => r.category === 'price_increase')
  assert.equal(prices[0].priority.score, prices[1].priority.score)
  assert.deepEqual(prices.map((r) => r.id), ['price_increase:alpha', 'price_increase:zeta'])
})

test('older findings are not treated as urgent', () => {
  const recent = build({ subscriptions: [sub({ slug: 'n', amount: 649, previousAmount: 499, priceIncreaseDate: d('2025-12-01') })] })
  const old = build({ subscriptions: [sub({ slug: 'n', amount: 649, previousAmount: 499, priceIncreaseDate: d('2024-12-01') })] })
  assert.ok(recent.recommendations[0].priority.score - old.recommendations[0].priority.score >= 20)
  assert.ok(old.recommendations[0].priority.factors.some((f) => f.factor === 'older_finding'))
})

// ================================================================ review integration
test('13. "not_subscription" never yields recommendations, savings or overlaps', () => {
  const out = build({
    subscriptions: [
      sub({ slug: 'netflix', name: 'Netflix', amount: 649, serviceDomain: 'video_streaming' }),
      sub({ slug: 'prime', name: 'Prime', amount: 299, serviceDomain: 'video_streaming', reviewStatus: 'not_subscription',
        previousAmount: 199, hasDuplicateCharges: true, duplicateConfidence: 'high', status: 'potentially_inactive' }),
    ],
    alerts: [anomaly({ anomalyKey: 'payment_anomaly:prime:t', subscriptionIds: ['prime'], anomalyReason: 'amount_higher_than_usual', currentAmount: 399, expectedAmount: 299 })],
  })
  assert.ok(out.recommendations.every((r) => !r.subscriptionIds.includes('prime')), JSON.stringify(ids(out)))
  assert.ok(out.recommendations.every((r) => !/prime/i.test(text(r))), 'no card even mentions the rejected subscription')
  assert.ok(!out.recommendations.some((r) => r.category === 'payment_anomaly'), 'anomalies of rejected subscriptions are dropped')
  assert.equal(out.summary.potentialSavings, 0)
  assert.equal(out.summary.rejectedCount, 1)
  assert.equal(out.summary.subscriptionCount, 1)
})

test('14-15. confirmed subscriptions keep genuine findings but get no review prompt; unreviewed prompts are limited', () => {
  const out = build({
    subscriptions: [
      sub({ slug: 'netflix', name: 'Netflix', amount: 649, previousAmount: 499, reviewStatus: 'confirmed', confidence: 0.6,
        hasDuplicateCharges: true, duplicateConfidence: 'high' }),
      ...['a', 'b', 'c', 'd', 'e'].map((x) => sub({ slug: `low-${x}`, name: `Low ${x}`, confidence: 0.5 + x.charCodeAt(0) / 1000 })),
      sub({ slug: 'steady', name: 'Steady', amount: 99, confidence: 0.97 }),
    ],
    alerts: [anomaly({ anomalyKey: 'payment_anomaly:netflix:t', subscriptionIds: ['netflix'], anomalyReason: 'paid_earlier_than_usual_or_duplicate' })],
  })
  for (const id of ['price_increase:netflix', 'duplicate_billing:netflix', 'payment_anomaly:payment_anomaly:netflix:t']) {
    assert.ok(ids(out).includes(id), id)
  }
  assert.ok(!ids(out).includes('unreviewed_subscription:netflix'), 'confirmed: no "is this a subscription?" prompt')
  const prompts = out.recommendations.filter((r) => r.category === 'unreviewed_subscription')
  assert.deepEqual(prompts.map((r) => r.id), ['unreviewed_subscription:low-a', 'unreviewed_subscription:low-b', 'unreviewed_subscription:low-c'])
  assert.ok(!ids(out).includes('unreviewed_subscription:steady'), 'confident, low-value detections are not prompted')
})

// ================================================================ financial integrity (pure)
test('17-21. savings breakdown: yearly normalization, no inactivity, no suspected, no double counting, no price increases', () => {
  const b = computeSavingsBreakdown([
    sub({ slug: 'dropbox', amount: 9900, billingInterval: 'yearly', hasDuplicateCharges: true, duplicateAmount: 9900, duplicateConfidence: 'high', serviceDomain: 'cloud_storage' }),
    sub({ slug: 'gdrive', amount: 1300, billingInterval: 'monthly', serviceDomain: 'cloud_storage' }),
    sub({ slug: 'gym', amount: 999, hasDuplicateCharges: true, duplicateConfidence: 'suspected' }),
    sub({ slug: 'adobe', amount: 1675, status: 'potentially_inactive' }),
    sub({ slug: 'netflix', amount: 649, previousAmount: 499 }),
  ])
  assert.equal(b.breakdown.duplicateExposure, 825, '₹9900/yr duplicate = ₹825/month')
  // Dropbox (₹825/mo) is the overlap secondary to GDrive (₹1300/mo) but already counted as a duplicate.
  assert.equal(b.breakdown.conditionalSavings, 0)
  assert.equal(b.breakdown.suspectedDuplicateExposure, 999)
  assert.equal(b.breakdown.inactivityReviewAmount, 1675)
  assert.equal(b.breakdown.priceIncreaseImpact, 150)
  assert.equal(b.potentialSavings, 825)
  assert.deepEqual(b.breakdown.excludedFromTotal, ['suspectedDuplicateExposure', 'inactivityReviewAmount', 'priceIncreaseImpact'])
})

test('recommendation categories map to the same alert visibility keys as the frontend', async () => {
  const src = readFileSync(new URL('../../frontend/src/lib/alertPreferences.ts', import.meta.url), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'subsense-map-'))
  const file = join(dir, 'alertPreferences.mjs')
  writeFileSync(file, stripTypeScriptTypes(src))
  const { alertCategory } = await import(pathToFileURL(file).href)
  const cases = [
    { type: 'price_increase' }, { type: 'duplicate' }, { type: 'duplicate', subType: 'service_overlap' },
    { type: 'service_overlap' }, { type: 'inactivity_review' }, { type: 'unused' }, { type: 'payment_anomaly' },
  ]
  for (const c of cases) assert.equal(alertPreferenceKey(c), alertCategory(c), JSON.stringify(c))
  const sourceType = { duplicate_billing: 'duplicate', payment_anomaly: 'payment_anomaly', price_increase: 'price_increase',
    service_overlap: 'service_overlap', inactivity_review: 'inactivity_review' }
  for (const [category, type] of Object.entries(sourceType)) {
    assert.equal(ALERT_PREFERENCE_BY_CATEGORY[category], alertCategory({ type }), category)
  }
})

// ================================================================ HTTP: security, persistence, isolation
let srv
let A
let B
before(async () => {
  if (FAKE) srv = await startServer()
})
after(async () => {
  if (srv) await srv.close()
})
beforeEach(async () => {
  if (!FAKE) return
  mongoose.__resetAll()
  srv.app.locals.resetRateLimits()
  A = new Client(srv.base)
  B = new Client(srv.base)
  await A.register('User A', 'a@example.com')
  await B.register('User B', 'b@example.com')
})

const monthly = (merchant, amount, months, { day = 14, year = 2025, startMonth = 1, account = 'HDFC 1111' } = {}) =>
  Array.from({ length: months }, (_, k) => {
    const dt = new Date(Date.UTC(year, startMonth - 1 + k, day)).toISOString().slice(0, 10)
    return `${dt},${merchant},${typeof amount === 'function' ? amount(k) : amount},${account}`
  })
const CSV = ['date,merchant,amount,account',
  ...monthly('POS DEBIT - NETFLIX.COM', (k) => (k < 6 ? 499 : 649), 9, { startMonth: 4 }),
  ...monthly('UPI/SPOTIFY AB/4028', 119, 7, { day: 8, startMonth: 6 }),
  '2025-12-09,UPI/SPOTIFY AB/4028,119,ICICI 2222',
].join('\n')
const patch = (client, path, json, opts) => client.request('PATCH', path, { ...opts, json })
const counts = () => [Alert, Subscription, Transaction, User, Session].map((M) => M.__all().length)

test('23. unauthenticated recommendation requests return 401', { skip }, async () => {
  const res = await new Client(srv.base).get('/recommendations')
  assert.equal(res.status, 401)
  assert.equal(res.data.code, 'UNAUTHENTICATED')
})

test('empty account: no fabricated recommendations', { skip }, async () => {
  const res = await A.get('/recommendations')
  assert.equal(res.status, 200)
  assert.deepEqual(res.data.recommendations, [])
  assert.equal(res.data.summary.transactionCount, 0)
  assert.equal(res.data.summary.subscriptionCount, 0)
  assert.equal(res.data.summary.monthlyRecurringSpend, 0)
  assert.match(res.data.meta.method, /no machine-learning predictions/)
})

test('8-9. focus is validated and persists across sessions', { skip }, async () => {
  for (const bad of ['aggressive', '', null, 1, ['balanced'], { $ne: 'x' }]) {
    assert.equal((await patch(A, '/auth/preferences', { recommendationFocus: bad })).status, 400, JSON.stringify(bad))
  }
  assert.equal((await A.get('/auth/me')).data.user.preferences.recommendationFocus, 'balanced')
  const res = await patch(A, '/auth/preferences', { recommendationFocus: 'billing_risks' })
  assert.equal(res.status, 200)
  assert.equal(res.data.preferences.recommendationFocus, 'billing_risks')
  assert.equal(res.data.preferences.alerts.duplicate, true, 'alert switches unaffected')
  assert.equal((await patch(A, '/auth/preferences', { recommendationFocus: 'reduce_costs', alerts: { duplicate: 'no' } })).status, 400)
  assert.equal(User.__all().find((u) => u._id === A.user.id).preferences.recommendationFocus, 'billing_risks', 'invalid request saved nothing')

  await A.post('/auth/logout', {})
  const again = new Client(srv.base)
  await again.post('/auth/login', { email: 'a@example.com', password: 'CorrectHorse9' })
  assert.equal((await again.get('/recommendations')).data.meta.focus, 'billing_risks')
  assert.equal((await B.get('/recommendations')).data.meta.focus, 'balanced', 'one user\'s focus never affects another')
})

test('16. reads are side-effect free: no records created or modified', { skip }, async () => {
  await A.importCsv(CSV)
  const before = JSON.stringify([Alert, Subscription, Transaction].map((M) => M.__all()))
  const n = counts()
  const r1 = await A.get('/recommendations')
  const r2 = await A.get('/recommendations')
  await A.get('/recommendations')
  assert.ok(r1.data.recommendations.length > 0)
  assert.deepEqual(counts(), n)
  assert.equal(JSON.stringify([Alert, Subscription, Transaction].map((M) => M.__all())), before)
  assert.deepEqual(r1.data.recommendations, r2.data.recommendations, 'stable ids, order and content')
  assert.equal(mongoose.__isFake && !('Recommendation' in mongoose), true)
})

test('24-26. isolation: own data only; identical merchants give independent results; forged ids ignored', { skip }, async () => {
  await A.importCsv(CSV)
  const bAlone = (await B.get('/recommendations')).data
  assert.deepEqual(bAlone.recommendations, [], 'B sees nothing from A')

  await B.importCsv(CSV)
  await review(B, 'netflix', 'not_subscription')
  const a = (await A.get(`/recommendations?userId=${B.user.id}&focus=billing_risks`, { headers: { 'X-User-Id': B.user.id } })).data
  const b = (await B.get('/recommendations')).data
  assert.ok(a.recommendations.some((r) => r.id === 'price_increase:netflix'), 'A still sees its own Netflix finding')
  assert.ok(!b.recommendations.some((r) => r.subscriptionIds.includes('netflix')), 'B rejected its Netflix; A is unaffected')
  assert.equal(a.meta.focus, 'balanced', 'focus comes from the saved preference, not the query')
  const aSourceAlerts = new Set(Alert.__all().filter((x) => x.userId === A.user.id).map((x) => String(x._id)))
  for (const r of a.recommendations) for (const id of r.sourceAlertIds) assert.ok(aSourceAlerts.has(id), `foreign alert ${id}`)
})

test('27. hidden alert categories hide matching cards without deleting alerts; re-enabling restores them', { skip }, async () => {
  await A.importCsv(CSV)
  const before = (await A.get('/recommendations')).data
  const alertCount = Alert.__all().length
  const priceIds = before.recommendations.filter((r) => r.category === 'price_increase').map((r) => r.id)
  assert.ok(priceIds.length > 0)

  await patch(A, '/auth/preferences', { alerts: { priceIncrease: false } })
  const hidden = (await A.get('/recommendations')).data
  assert.ok(hidden.recommendations.every((r) => r.category !== 'price_increase'))
  assert.equal(hidden.hidden.byCategory.price_increase, priceIds.length)
  assert.equal(Alert.__all().length, alertCount, 'alerts are not deleted')
  assert.deepEqual(hidden.summary.savingsBreakdown, before.summary.savingsBreakdown, 'analytics unaffected')

  await patch(A, '/auth/preferences', { alerts: { priceIncrease: true } })
  assert.deepEqual((await A.get('/recommendations')).data.recommendations, before.recommendations)
})

test('KPIs and recommendations report the same corrected savings figures', { skip }, async () => {
  await A.importCsv(CSV)
  const kpis = (await A.get('/analytics/kpis')).data
  const recs = (await A.get('/recommendations')).data
  assert.equal(kpis.potentialSavings, recs.summary.potentialSavings)
  assert.deepEqual(kpis.savingsBreakdown, recs.summary.savingsBreakdown)
  assert.equal(kpis.monthlySpend, recs.summary.monthlyRecurringSpend)
  assert.equal(kpis.potentialSavings,
    Math.round((kpis.savingsBreakdown.duplicateExposure + kpis.savingsBreakdown.conditionalSavings) * 100) / 100)
})

const review = (client, id, reviewStatus) => client.request('PATCH', `/subscriptions/${id}/review`, { json: { reviewStatus } })
