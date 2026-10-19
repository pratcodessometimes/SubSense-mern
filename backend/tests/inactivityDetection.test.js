import assert from 'node:assert/strict'
import test from 'node:test'
import { newTestUserId } from './support/testUsers.mjs'
import {
  analyzeMerchantRecurrence,
  detectDuplicateCharges,
  evaluateSubscriptionActivity,
  getNominalNextBillingDate,
  syncAlertsForSubscriptions,
} from '../src/services/detectionService.js'

test('Scenario 1: Active monthly subscription remains active', () => {
  const lastPayment = '2026-05-15'
  const expectedBilling = '2026-06-15'
  const refDate = '2026-05-25' // 10 days after payment, 21 days before next billing

  const result = evaluateSubscriptionActivity(
    lastPayment,
    expectedBilling,
    'monthly',
    4,
    refDate,
    649,
  )

  assert.equal(result.status, 'active')
  assert.equal(result.confidenceLabel, 'High Confidence')
  assert.equal(result.daysSinceLastPayment, 10)
  assert.ok(result.daysOverdue <= 0)
  assert.equal(result.amountAtRisk, 0)
})

test('Scenario 2: Active yearly subscription remains active', () => {
  const lastPayment = '2025-10-01'
  const expectedBilling = '2026-10-01'
  const refDate = '2026-04-01' // 6 months in

  const result = evaluateSubscriptionActivity(
    lastPayment,
    expectedBilling,
    'yearly',
    3,
    refDate,
    1499,
  )

  assert.equal(result.status, 'active')
  assert.equal(result.confidenceLabel, 'High Confidence')
  assert.ok(result.daysOverdue <= 0)
  assert.equal(result.amountAtRisk, 0)
})

test('Scenario 3: Missing expected monthly payment generates an appropriate review alert', () => {
  const lastPayment = '2026-05-01'
  const expectedBilling = '2026-06-01'
  const refDate = '2026-07-15' // 44 days past expected date (> 35d default grace period)

  const result = evaluateSubscriptionActivity(
    lastPayment,
    expectedBilling,
    'monthly',
    5,
    refDate,
    499,
  )

  assert.equal(result.status, 'potentially_inactive')
  assert.equal(result.confidenceLabel, 'Moderate Evidence')
  assert.equal(result.daysSinceLastPayment, 75)
  assert.equal(result.daysOverdue, 44)
  assert.equal(result.amountAtRisk, 499)
  assert.ok(result.inactivityEvidence.includes('44 days overdue'))
})

test('Scenario 4: Missing yearly payment is evaluated correctly', () => {
  const lastPayment = '2024-06-01'
  const expectedBilling = '2025-06-01'
  const refDate = '2025-09-15' // 106 days past renewal date (> 85d yearly grace period)

  const result = evaluateSubscriptionActivity(
    lastPayment,
    expectedBilling,
    'yearly',
    3,
    refDate,
    2999,
  )

  assert.equal(result.status, 'potentially_inactive')
  assert.equal(result.confidenceLabel, 'High Confidence')
  assert.equal(result.daysOverdue, 106)
  assert.equal(result.amountAtRisk, 2999)
  assert.ok(result.inactivityEvidence.includes('106 days overdue'))
})

test('Scenario 5: Small billing delays do not cause false inactivity alerts', () => {
  const lastPayment = '2026-06-01'
  const expectedBilling = '2026-07-01'
  const refDate = '2026-07-05' // 4 days past expected billing date (small delay)

  const result = evaluateSubscriptionActivity(
    lastPayment,
    expectedBilling,
    'monthly',
    4,
    refDate,
    199,
    '',
    7, // 7-day custom grace period
  )

  assert.equal(result.status, 'active')
  assert.equal(result.confidenceLabel, 'High Confidence')
  assert.equal(result.amountAtRisk, 0)
})

test('Scenario 6: Insufficient history produces an uncertain/review outcome rather than a false conclusion', () => {
  const lastPayment = '2026-05-01'
  const expectedBilling = '2026-06-01'
  const refDate = '2026-07-15' // 44 days past expected billing

  const result = evaluateSubscriptionActivity(
    lastPayment,
    expectedBilling,
    'monthly',
    2, // Only 2 historical transactions!
    refDate,
    799,
  )

  assert.equal(result.status, 'needs_review')
  assert.equal(result.confidenceLabel, 'Preliminary Review')
  assert.ok(result.inactivityEvidence.includes('Only 2 recorded payments exist'))
  assert.equal(result.amountAtRisk, 799)
})

test('Scenario 7: Explicit manual cancellation override is preserved', () => {
  const lastPayment = '2026-06-01'
  const expectedBilling = '2026-07-01'
  const refDate = '2026-07-10'

  const result = evaluateSubscriptionActivity(
    lastPayment,
    expectedBilling,
    'monthly',
    4,
    refDate,
    299,
    '[manual] [cancelled] User switched providers',
  )

  assert.equal(result.status, 'confirmed_cancelled')
  assert.equal(result.confidenceLabel, 'Verified Manual')
  assert.equal(result.amountAtRisk, 0)
})

test('Scenario 8: Deterministic analyzeMerchantRecurrence with referenceDate', () => {
  const txs = [
    { date: new Date('2026-01-10'), amount: 499, _id: 'tx1' },
    { date: new Date('2026-02-10'), amount: 499, _id: 'tx2' },
    { date: new Date('2026-03-10'), amount: 499, _id: 'tx3' },
  ]

  // Test active state using referenceDate shortly after 3rd payment
  const activeResult = analyzeMerchantRecurrence(txs, 'Hotstar', 'Streaming', '2026-03-25')
  assert.ok(activeResult)
  assert.equal(activeResult.status, 'active')
  assert.equal(activeResult.confidenceLabel, 'High Confidence')

  // Test overdue/inactive state using referenceDate 60 days after expected payment
  const inactiveResult = analyzeMerchantRecurrence(txs, 'Hotstar', 'Streaming', '2026-05-25')
  assert.ok(inactiveResult)
  assert.equal(inactiveResult.status, 'potentially_inactive')
  assert.ok(inactiveResult.daysOverdue > 35)
})

test('Scenario 9: Differentiate confirmed vs suspected duplicate charges', () => {
  // Multi-account billing -> Confirmed duplicate
  const multiAccountTxs = [
    { date: new Date('2026-06-10'), amount: 649, account: 'HDFC CC' },
    { date: new Date('2026-06-10'), amount: 649, account: 'SBI Savings' },
    { date: new Date('2026-07-10'), amount: 649, account: 'HDFC CC' },
    { date: new Date('2026-07-10'), amount: 649, account: 'SBI Savings' },
  ]
  const confirmedRes = detectDuplicateCharges(multiAccountTxs, 'monthly', 649)
  assert.equal(confirmedRes.hasDuplicateCharges, true)
  assert.equal(confirmedRes.duplicateConfidence, 'high')
  assert.equal(confirmedRes.duplicateSubType, 'confirmed_duplicate')

  // Single isolated proximity charge without multi-account proof -> Suspected duplicate
  const suspectedTxs = [
    { date: new Date('2026-06-10'), amount: 199, account: 'Default Card' },
    { date: new Date('2026-06-12'), amount: 199, account: 'Default Card' },
    { date: new Date('2026-07-10'), amount: 199, account: 'Default Card' },
  ]
  const suspectedRes = detectDuplicateCharges(suspectedTxs, 'monthly', 199)
  assert.equal(suspectedRes.hasDuplicateCharges, true)
  assert.equal(suspectedRes.duplicateConfidence, 'suspected')
  assert.equal(suspectedRes.duplicateSubType, 'suspected_duplicate')
})

test('Scenario 10: Empty or missing transaction data does not crash detection', () => {
  assert.equal(analyzeMerchantRecurrence([], 'Empty', 'None'), null)
  assert.equal(analyzeMerchantRecurrence(null, 'Null', 'None'), null)

  const dupRes = detectDuplicateCharges([], 'monthly')
  assert.equal(dupRes.hasDuplicateCharges, false)
  assert.equal(dupRes.duplicateAmount, 0)
})

test('Scenario 11: Alert Coexistence - Independent alert types for same subscription', async () => {
  const mongoose = (await import('mongoose')).default
  const { Alert } = await import('../src/models/Alert.js')
  await import('dotenv/config')

  if (!process.env.MONGO_URI) return
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(process.env.MONGO_URI)
  }

  const USER = newTestUserId()
  const testSlug = `test-coexist-${Date.now()}`
  const manualTitle = `Manual override ${Date.now()}`

  // Create a manual alert that must be preserved
  const manualAlert = await Alert.create({
    userId: USER,
    type: 'price_increase',
    severity: 'warning',
    title: manualTitle,
    description: 'User created manual alert',
    subscriptionIds: [testSlug],
    impact: '₹100/mo',
    impactLabel: 'Manual check',
    isManual: true,
  })

  // Mock subscription with BOTH price increase, duplicate charges, and inactivity review
  const testSub = {
    slug: testSlug,
    name: 'Coexist Service',
    category: 'Software',
    serviceDomain: 'cloud_storage',
    amount: 899,
    previousAmount: 699,
    priceChangePct: 28.6,
    monthlyDifference: 200,
    annualImpact: 2400,
    hasDuplicateCharges: true,
    duplicateAccounts: ['HDFC Card', 'Axis Card'],
    duplicateAmount: 899,
    duplicateConfidence: 'high',
    billingInterval: 'monthly',
    status: 'potentially_inactive',
    daysSinceLastPayment: 70,
    daysOverdue: 40,
    lastActivity: new Date('2026-05-01'),
    nextBillingDate: new Date('2026-06-01'),
  }

  try {
    await syncAlertsForSubscriptions(USER, [testSub])

    // 1. Verify Price Increase Alert was generated
    const priceAlert = await Alert.findOne({
      subscriptionIds: testSlug,
      type: 'price_increase',
      isManual: false,
    })
    assert.ok(priceAlert, 'Price increase alert must coexist')
    assert.equal(priceAlert.percentageChange, 28.6)

    // 2. Verify Duplicate Alert was generated
    const dupAlert = await Alert.findOne({
      subscriptionIds: testSlug,
      type: 'duplicate',
      isManual: false,
    })
    assert.ok(dupAlert, 'Duplicate alert must coexist')
    assert.equal(dupAlert.subType, 'confirmed_duplicate')
    assert.equal(dupAlert.currentAmount, 899)

    // 3. Verify Inactivity Review Alert was generated
    const inactiveAlert = await Alert.findOne({
      subscriptionIds: testSlug,
      type: 'inactivity_review',
      isManual: false,
    })
    assert.ok(inactiveAlert, 'Inactivity review alert must coexist')
    assert.equal(inactiveAlert.daysOverdue, 40)
    assert.equal(inactiveAlert.daysSinceLastPayment, 70)

    // 4. Verify Manual Alert was preserved
    const manualFound = await Alert.findById(manualAlert._id)
    assert.ok(manualFound, 'Manual alert must be preserved')

    // 5. Verify Resumed Payment clears inactivity alert
    const resumedSub = {
      ...testSub,
      status: 'active',
      daysOverdue: -15,
      daysSinceLastPayment: 5,
      lastActivity: new Date('2026-07-01'),
      nextBillingDate: new Date('2026-08-01'),
    }

    await syncAlertsForSubscriptions(USER, [resumedSub])

    const clearedInactiveAlert = await Alert.findOne({
      subscriptionIds: testSlug,
      type: 'inactivity_review',
      isManual: false,
    })
    assert.equal(clearedInactiveAlert, null, 'Inactivity alert must be removed when subscription is active again')

    // Price and duplicate alerts must still remain
    const retainedPrice = await Alert.findOne({ subscriptionIds: testSlug, type: 'price_increase', isManual: false })
    assert.ok(retainedPrice, 'Price increase alert must be retained after inactivity clears')
  } finally {
    await Alert.deleteMany({ userId: USER, subscriptionIds: testSlug })
    await Alert.findByIdAndDelete(manualAlert._id)
    await mongoose.disconnect()
  }
})

test('Scenario 12: Calendar-aware nominal vs rolled next billing date', () => {
  const lastMonthly = new Date('2026-01-31')
  const nominalMonthly = getNominalNextBillingDate(lastMonthly, 'monthly')
  // Jan 31 + 1 month adjusts to last day of Feb (28th in 2026)
  assert.equal(nominalMonthly.getDate(), 28)
  assert.equal(nominalMonthly.getMonth(), 1) // February is index 1

  const lastYearly = new Date('2025-04-10')
  const nominalYearly = getNominalNextBillingDate(lastYearly, 'yearly')
  assert.equal(nominalYearly.getFullYear(), 2026)
  assert.equal(nominalYearly.getMonth(), 3) // April
  assert.equal(nominalYearly.getDate(), 10)
})
