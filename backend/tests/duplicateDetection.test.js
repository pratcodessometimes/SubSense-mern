import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeMerchantRecurrence,
  detectDuplicateCharges,
  detectServiceOverlaps,
  syncAlertsForSubscriptions,
} from '../src/services/detectionService.js'
import { normalizeMerchant } from '../src/services/merchantNormalizer.js'
import { newTestUserId } from './support/testUsers.mjs'

test('Duplicate Charges - Positive: Same merchant billed on multiple accounts in same cycle', () => {
  const txs = [
    { date: new Date('2026-06-14'), amount: 649, account: 'HDFC Credit Card' },
    { date: new Date('2026-06-14'), amount: 649, account: 'SBI Savings' },
    { date: new Date('2026-07-14'), amount: 649, account: 'HDFC Credit Card' },
    { date: new Date('2026-07-14'), amount: 649, account: 'SBI Savings' },
    { date: new Date('2026-08-14'), amount: 649, account: 'HDFC Credit Card' },
    { date: new Date('2026-08-14'), amount: 649, account: 'SBI Savings' },
  ]

  const result = detectDuplicateCharges(txs, 'monthly', 649)
  assert.equal(result.hasDuplicateCharges, true)
  assert.equal(result.duplicateAmount, 649)
  assert.ok(result.duplicateAccounts.includes('HDFC Credit Card'))
  assert.ok(result.duplicateAccounts.includes('SBI Savings'))
  assert.equal(result.duplicateCyclesCount, 3)
})

test('Duplicate Charges - Positive: Intra-cycle accidental double billing on same account', () => {
  const txs = [
    { date: new Date('2026-06-05'), amount: 119, account: 'ICICI Bank' },
    { date: new Date('2026-06-08'), amount: 119, account: 'ICICI Bank' }, // 3 days later
    { date: new Date('2026-07-05'), amount: 119, account: 'ICICI Bank' },
    { date: new Date('2026-08-05'), amount: 119, account: 'ICICI Bank' },
  ]

  const result = detectDuplicateCharges(txs, 'monthly', 119)
  assert.equal(result.hasDuplicateCharges, true)
  assert.equal(result.duplicateAmount, 119)
  assert.ok(result.duplicateAccounts.includes('ICICI Bank'))
})

test('Duplicate Charges - Negative: Normal single recurring subscription', () => {
  const txs = [
    { date: new Date('2026-06-14'), amount: 649, account: 'HDFC Credit Card' },
    { date: new Date('2026-07-14'), amount: 649, account: 'HDFC Credit Card' },
    { date: new Date('2026-08-14'), amount: 649, account: 'HDFC Credit Card' },
  ]

  const result = detectDuplicateCharges(txs, 'monthly', 649)
  assert.equal(result.hasDuplicateCharges, false)
  assert.equal(result.duplicateAccounts.length, 0)
})

test('Duplicate Charges - Negative: Legitimate price increase does not trigger duplicate charges', () => {
  const txs = [
    { date: new Date('2026-05-14'), amount: 499, account: 'HDFC' },
    { date: new Date('2026-06-14'), amount: 499, account: 'HDFC' },
    { date: new Date('2026-07-14'), amount: 649, account: 'HDFC' },
    { date: new Date('2026-08-14'), amount: 649, account: 'HDFC' },
  ]

  const result = detectDuplicateCharges(txs, 'monthly', 649)
  assert.equal(result.hasDuplicateCharges, false)
})

test('Service Overlaps - Positive: Competing subscriptions in same domain (music streaming)', () => {
  const subs = [
    {
      slug: 'spotify',
      name: 'Spotify',
      category: 'Music',
      serviceDomain: 'music_streaming',
      amount: 119,
      billingInterval: 'monthly',
      status: 'active',
    },
    {
      slug: 'apple-music',
      name: 'Apple Music',
      category: 'Music',
      serviceDomain: 'music_streaming',
      amount: 99,
      billingInterval: 'monthly',
      status: 'active',
    },
  ]

  const overlaps = detectServiceOverlaps(subs)
  assert.equal(overlaps.length, 1)
  assert.equal(overlaps[0].serviceDomain, 'music_streaming')
  assert.equal(overlaps[0].domainLabel, 'music streaming')
  assert.equal(overlaps[0].subscriptionNames.length, 2)
  assert.equal(overlaps[0].totalMonthly, 218)
  assert.equal(overlaps[0].potentialMonthlySavings, 99)
  assert.equal(overlaps[0].potentialAnnualSavings, 1188)
})

test('Service Overlaps - Positive: Mixed monthly and yearly billing in video streaming', () => {
  const subs = [
    {
      slug: 'netflix',
      name: 'Netflix',
      category: 'Streaming',
      serviceDomain: 'video_streaming',
      amount: 649,
      billingInterval: 'monthly',
      status: 'active',
    },
    {
      slug: 'amazon-prime',
      name: 'Amazon Prime',
      category: 'Streaming',
      serviceDomain: 'video_streaming',
      amount: 1499,
      billingInterval: 'yearly',
      status: 'active',
    },
  ]

  const overlaps = detectServiceOverlaps(subs)
  assert.equal(overlaps.length, 1)
  assert.equal(overlaps[0].serviceDomain, 'video_streaming')
  assert.equal(overlaps[0].domainLabel, 'video streaming')
  // Netflix monthly: 649, Prime normalized monthly: 1499 / 12 = 124.92
  assert.equal(overlaps[0].totalMonthly, 773.92)
  assert.equal(overlaps[0].potentialMonthlySavings, 124.92)
  assert.equal(overlaps[0].potentialAnnualSavings, 1499)
})

test('Service Overlaps - Negative: Shared category but distinct service domains must NOT trigger overlap', () => {
  // CRITICAL REQUIREMENT 3: Never classify subscriptions as duplicates solely because they share a category
  const subs = [
    {
      slug: 'aws',
      name: 'AWS',
      category: 'Cloud',
      serviceDomain: 'cloud_infrastructure',
      amount: 2500,
      billingInterval: 'monthly',
      status: 'active',
    },
    {
      slug: 'google-one',
      name: 'Google One',
      category: 'Cloud',
      serviceDomain: 'cloud_storage',
      amount: 130,
      billingInterval: 'monthly',
      status: 'active',
    },
  ]

  const overlaps = detectServiceOverlaps(subs)
  assert.equal(overlaps.length, 0, 'AWS (cloud_infrastructure) and Google One (cloud_storage) must NOT overlap')
})

test('Service Overlaps - Negative: Software category with different functional domains', () => {
  const subs = [
    {
      slug: 'figma',
      name: 'Figma',
      category: 'Software',
      serviceDomain: 'design_tool',
      amount: 1200,
      billingInterval: 'monthly',
      status: 'active',
    },
    {
      slug: 'github-copilot',
      name: 'GitHub Copilot',
      category: 'Software',
      serviceDomain: 'ai_coding',
      amount: 850,
      billingInterval: 'monthly',
      status: 'active',
    },
  ]

  const overlaps = detectServiceOverlaps(subs)
  assert.equal(overlaps.length, 0, 'Figma and Copilot must NOT overlap despite sharing Software category')
})

test('Detection Integration - analyzeMerchantRecurrence detects duplicate charges and assigns status', () => {
  const txs = [
    { date: new Date('2026-06-14'), amount: 649, account: 'HDFC CC', _id: 'd1' },
    { date: new Date('2026-06-14'), amount: 649, account: 'SBI Savings', _id: 'd2' },
    { date: new Date('2026-07-14'), amount: 649, account: 'HDFC CC', _id: 'd3' },
    { date: new Date('2026-07-14'), amount: 649, account: 'SBI Savings', _id: 'd4' },
    { date: new Date('2026-08-14'), amount: 649, account: 'HDFC CC', _id: 'd5' },
    { date: new Date('2026-08-14'), amount: 649, account: 'SBI Savings', _id: 'd6' },
  ]

  const result = analyzeMerchantRecurrence(txs, 'Netflix', 'Streaming')
  assert.ok(result, 'Must detect recurrence')
  assert.equal(result.hasDuplicateCharges, true)
  assert.equal(result.status, 'duplicate')
  assert.equal(result.duplicateAmount, 649)
  assert.ok(result.duplicateAccounts.includes('HDFC CC'))
  assert.ok(result.duplicateAccounts.includes('SBI Savings'))
})

test('Alert Intelligence Integration - syncAlertsForSubscriptions coexists independent alert types and protects manual alerts', async () => {
  const mongoose = (await import('mongoose')).default
  const { Alert } = await import('../src/models/Alert.js')
  await import('dotenv/config')

  if (!process.env.MONGO_URI) {
    return
  }

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGO_URI)
  }

  const USER = newTestUserId()
  const testPrefix = `test-p22-${Date.now()}`
  const netflixSlug = `${testPrefix}-netflix`
  const primeSlug = `${testPrefix}-prime`
  const spotifySlug = `${testPrefix}-spotify`
  const manualTitle = `Manual Alert ${Date.now()}`

  // 1. Create a manual alert that must NEVER be touched
  const manualAlert = await Alert.create({
    userId: USER,
    type: 'duplicate',
    severity: 'warning',
    title: manualTitle,
    description: 'User manually created audit reminder',
    subscriptionIds: [netflixSlug],
    impact: '₹500',
    impactLabel: 'Manual estimate',
    isManual: true,
  })

  // Test subscriptions:
  // - Netflix has price increase AND is in video_streaming serviceDomain
  // - Prime is also in video_streaming serviceDomain (forming a service overlap with Netflix!)
  // - Spotify has confirmed duplicate charges (multi-account)
  const testSubs = [
    {
      slug: netflixSlug,
      name: 'Netflix Test',
      category: 'Streaming',
      serviceDomain: 'video_streaming',
      amount: 649,
      previousAmount: 499,
      priceChangePct: 30.1,
      monthlyDifference: 150,
      annualImpact: 1800,
      billingInterval: 'monthly',
      status: 'price_increase',
    },
    {
      slug: primeSlug,
      name: 'Amazon Prime Test',
      category: 'Streaming',
      serviceDomain: 'video_streaming',
      amount: 1499,
      billingInterval: 'yearly',
      status: 'active',
    },
    {
      slug: spotifySlug,
      name: 'Spotify Test',
      category: 'Music',
      serviceDomain: 'music_streaming',
      amount: 119,
      billingInterval: 'monthly',
      status: 'duplicate',
      hasDuplicateCharges: true,
      duplicateAccounts: ['HDFC Card', 'SBI Card'],
      duplicateAmount: 119,
    },
  ]

  try {
    // First run of synchronization
    await syncAlertsForSubscriptions(USER, testSubs)

    // Verify 1: Netflix has an active price_increase alert
    const priceAlert = await Alert.findOne({
      subscriptionIds: netflixSlug,
      type: 'price_increase',
      isManual: false,
    })
    assert.ok(priceAlert, 'Netflix must receive a price increase alert')
    assert.equal(priceAlert.previousAmount, 499)
    assert.equal(priceAlert.currentAmount, 649)

    // Verify 2: Video streaming service overlap alert was created with both Netflix and Prime
    const overlapAlert = await Alert.findOne({
      serviceDomain: 'video_streaming',
      type: 'service_overlap',
      isManual: false,
    })
    assert.ok(overlapAlert, 'Video streaming service overlap alert must be created')
    assert.ok(overlapAlert.subscriptionIds.includes(netflixSlug))
    assert.ok(overlapAlert.subscriptionIds.includes(primeSlug))
    assert.equal(overlapAlert.subType, 'service_overlap')
    assert.equal(overlapAlert.severity, 'warning')
    assert.equal(overlapAlert.impact, '₹773.92 / month')

    // Verify 3: Spotify has a confirmed duplicate charge alert
    const duplicateAlert = await Alert.findOne({
      subscriptionIds: spotifySlug,
      type: 'duplicate',
      subType: 'confirmed_duplicate',
      isManual: false,
    })
    assert.ok(duplicateAlert, 'Spotify must receive a confirmed duplicate charge alert')
    assert.equal(duplicateAlert.severity, 'critical')
    assert.ok(duplicateAlert.duplicateAccounts.includes('HDFC Card'))
    assert.ok(duplicateAlert.duplicateAccounts.includes('SBI Card'))

    // Verify 4: Manual alert was preserved
    const manualFound = await Alert.findById(manualAlert._id)
    assert.ok(manualFound, 'Manual alert must remain intact')

    // Verify 5: Repeated run is completely idempotent
    await syncAlertsForSubscriptions(USER, testSubs)

    const priceAlertsAfter = await Alert.find({
      subscriptionIds: netflixSlug,
      type: 'price_increase',
      isManual: false,
    })
    assert.equal(priceAlertsAfter.length, 1, 'Repeated run must not duplicate price alerts')

    const overlapAlertsAfter = await Alert.find({
      serviceDomain: 'video_streaming',
      type: 'service_overlap',
      isManual: false,
    })
    assert.equal(overlapAlertsAfter.length, 1, 'Repeated run must not duplicate overlap alerts')

    const dupAlertsAfter = await Alert.find({
      subscriptionIds: spotifySlug,
      type: 'duplicate',
      subType: 'confirmed_duplicate',
      isManual: false,
    })
    assert.equal(dupAlertsAfter.length, 1, 'Repeated run must not duplicate confirmed duplicate alerts')
  } finally {
    // Clean up test documents
    await Alert.deleteMany({
      userId: USER,
      $or: [
        { subscriptionIds: { $in: [netflixSlug, primeSlug, spotifySlug] } },
        { serviceDomain: 'video_streaming', title: /Netflix Test/ },
      ],
    })
    await Alert.findByIdAndDelete(manualAlert._id)
    await mongoose.disconnect()
  }
})
