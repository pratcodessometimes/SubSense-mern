import assert from 'node:assert/strict'
import test from 'node:test'
import {
  detectPriceIncrease,
  analyzeMerchantRecurrence,
  syncAlertsForSubscriptions,
} from '../src/services/detectionService.js'
import { newTestUserId } from './support/testUsers.mjs'

test('Price Increase Intelligence - Valid monthly price increase', () => {
  const amounts = [499, 499, 649, 649]
  const dates = [
    new Date('2026-05-14'),
    new Date('2026-06-14'),
    new Date('2026-07-14'),
    new Date('2026-08-14'),
  ]

  const result = detectPriceIncrease(amounts, 'monthly', dates)

  assert.equal(result.hasPriceIncrease, true)
  assert.equal(result.previousAmount, 499)
  assert.equal(result.currentAmount, 649)
  assert.equal(result.priceChangePct, 30.1)
  assert.equal(result.monthlyDifference, 150)
  assert.equal(result.annualImpact, 1800)
  assert.equal(result.priceIncreaseDate.toISOString(), dates[2].toISOString())
})

test('Price Increase Intelligence - Valid single-step recent monthly price increase', () => {
  const amounts = [499, 499, 499, 649]
  const dates = [
    new Date('2026-05-10'),
    new Date('2026-06-10'),
    new Date('2026-07-10'),
    new Date('2026-08-10'),
  ]

  const result = detectPriceIncrease(amounts, 'monthly', dates)

  assert.equal(result.hasPriceIncrease, true)
  assert.equal(result.previousAmount, 499)
  assert.equal(result.currentAmount, 649)
  assert.equal(result.monthlyDifference, 150)
  assert.equal(result.annualImpact, 1800)
})

test('Price Increase Intelligence - Valid yearly subscription price increase', () => {
  const amounts = [1499, 1499, 1799]
  const dates = [
    new Date('2024-09-10'),
    new Date('2025-09-10'),
    new Date('2026-09-10'),
  ]

  const result = detectPriceIncrease(amounts, 'yearly', dates)

  assert.equal(result.hasPriceIncrease, true)
  assert.equal(result.previousAmount, 1499)
  assert.equal(result.currentAmount, 1799)
  assert.equal(result.priceChangePct, 20.0)
  // Monthly difference for yearly plan is diff / 12 (300 / 12 = 25)
  assert.equal(result.monthlyDifference, 25)
  // Annual impact for yearly plan is diff (300)
  assert.equal(result.annualImpact, 300)
  assert.equal(result.priceIncreaseDate.toISOString(), dates[2].toISOString())
})

test('Price Increase Intelligence - Unchanged prices must NOT trigger price increase', () => {
  const amounts = [649, 649, 649, 649]
  const result = detectPriceIncrease(amounts, 'monthly')

  assert.equal(result.hasPriceIncrease, false)
  assert.equal(result.previousAmount, undefined)
})

test('Price Increase Intelligence - Minor fluctuations (<5% jitter/FX/tax) must NOT trigger price increase', () => {
  // Minor variation around 500 (~0.4% - 1.2% variance)
  const amounts = [499, 503, 498, 505]
  const result = detectPriceIncrease(amounts, 'monthly')

  assert.equal(result.hasPriceIncrease, false, 'Minor fluctuations must be ignored to prevent false alerts')
})

test('Price Increase Intelligence - Small yearly price variation (<5%) must NOT trigger price increase', () => {
  // 1499 -> 1530 is ~2.07% variation (e.g. currency conversion fee)
  const amounts = [1499, 1530]
  const result = detectPriceIncrease(amounts, 'yearly')

  assert.equal(result.hasPriceIncrease, false, 'Small yearly variation must not trigger false alerts')
})

test('Price Increase Intelligence - Reverting temporary spike must NOT trigger price increase', () => {
  // Temporary spike at index 2 that reverted back to 499 at index 3
  const amounts = [499, 499, 649, 499]
  const result = detectPriceIncrease(amounts, 'monthly')

  assert.equal(result.hasPriceIncrease, false, 'Reverting temporary charge must not trigger price increase')
})

test('Price Increase Intelligence - Price downgrade/decrease must NOT trigger price increase', () => {
  const amounts = [649, 649, 499, 499]
  const result = detectPriceIncrease(amounts, 'monthly')

  assert.equal(result.hasPriceIncrease, false, 'Price reduction/downgrade must not trigger price increase')
})

test('Price Increase Intelligence - Multiple historical price tiers identifies immediate previous baseline', () => {
  // 299 -> 499 -> 649
  const amounts = [299, 299, 499, 499, 649, 649]
  const result = detectPriceIncrease(amounts, 'monthly')

  assert.equal(result.hasPriceIncrease, true)
  assert.equal(result.previousAmount, 499, 'Previous amount must be the immediately preceding tier, not the ancient tier')
  assert.equal(result.currentAmount, 649)
  assert.equal(result.monthlyDifference, 150)
  assert.equal(result.annualImpact, 1800)
})

test('Price Increase Intelligence - Integration into analyzeMerchantRecurrence', () => {
  const txs = [
    { date: new Date('2026-05-14'), amount: 499, _id: 'tx1' },
    { date: new Date('2026-06-14'), amount: 499, _id: 'tx2' },
    { date: new Date('2026-07-14'), amount: 649, _id: 'tx3' },
    { date: new Date('2026-08-14'), amount: 649, _id: 'tx4' },
  ]

  const detected = analyzeMerchantRecurrence(txs, 'Netflix', 'Streaming')
  assert.ok(detected)
  assert.equal(detected.status, 'price_increase')
  assert.equal(detected.amount, 649)
  assert.equal(detected.previousAmount, 499)
  assert.equal(detected.priceChangePct, 30.1)
  assert.equal(detected.monthlyDifference, 150)
  assert.equal(detected.annualImpact, 1800)
  assert.ok(detected.priceIncreaseDate)
})

test('Price Increase Intelligence - syncAlertsForSubscriptions is idempotent and preserves manual alerts', async () => {
  const mongoose = (await import('mongoose')).default
  const { Alert } = await import('../src/models/Alert.js')
  await import('dotenv/config')

  if (!process.env.MONGO_URI) {
    return
  }

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGO_URI)
  }

  // Set up mock test data (owned by a throwaway test user)
  const USER = newTestUserId()
  const testSubSlug = `test-netflix-${Date.now()}`
  const manualAlertTitle = `Manual Budget Alert ${Date.now()}`

  // 1. Create a manual alert
  const manualAlert = await Alert.create({
    userId: USER,
    type: 'price_increase',
    severity: 'warning',
    title: manualAlertTitle,
    description: 'Manually logged alert by user',
    subscriptionIds: [testSubSlug],
    impact: '₹1,000',
    impactLabel: 'Manual estimate',
    isManual: true,
  })

  // Subscriptions to test: 1 with price increase, 1 unchanged active
  const testSubs = [
    {
      slug: testSubSlug,
      name: 'Test Netflix',
      category: 'Streaming',
      amount: 649,
      previousAmount: 499,
      priceChangePct: 30.1,
      monthlyDifference: 150,
      annualImpact: 1800,
      billingInterval: 'monthly',
      status: 'price_increase',
    },
    {
      slug: `test-spotify-${Date.now()}`,
      name: 'Test Spotify',
      category: 'Music',
      amount: 119,
      billingInterval: 'monthly',
      status: 'active',
    },
  ]

  try {
    // First run of synchronization
    await syncAlertsForSubscriptions(USER, testSubs)

    // Check automated alert was created
    const autoAlert1 = await Alert.findOne({
      subscriptionIds: testSubSlug,
      isManual: false,
    })
    assert.ok(autoAlert1, 'Automated price increase alert must be created')
    assert.equal(autoAlert1.type, 'price_increase')
    assert.equal(autoAlert1.previousAmount, 499)
    assert.equal(autoAlert1.currentAmount, 649)
    assert.equal(autoAlert1.monthlyImpact, 150)
    assert.equal(autoAlert1.annualImpact, 1800)
    assert.equal(autoAlert1.impact, '+₹1,800/yr')

    // Check manual alert was NOT deleted
    const manualCheck1 = await Alert.findById(manualAlert._id)
    assert.ok(manualCheck1, 'Manual alert must be preserved across sync runs')

    const initialAutoId = autoAlert1._id.toString()

    // Second run of synchronization (repeated analysis)
    await syncAlertsForSubscriptions(USER, testSubs)

    // Check that NO duplicate was created and same alert was retained
    const matchingAutoAlerts = await Alert.find({
      subscriptionIds: testSubSlug,
      isManual: false,
    })
    assert.equal(matchingAutoAlerts.length, 1, 'Repeated analysis must NOT create duplicate alerts')
    assert.equal(matchingAutoAlerts[0]._id.toString(), initialAutoId, 'Existing alert ID must be retained')

    // Check manual alert is still present
    const manualCheck2 = await Alert.findById(manualAlert._id)
    assert.ok(manualCheck2, 'Manual alert must remain preserved after repeated sync')
  } finally {
    // Clean up test documents
    await Alert.deleteMany({ userId: USER, subscriptionIds: testSubSlug })
    await Alert.findByIdAndDelete(manualAlert._id)
    await mongoose.disconnect()
  }
})

