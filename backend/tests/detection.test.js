import assert from 'node:assert/strict'
import test from 'node:test'
import {
  analyzeMerchantRecurrence,
  calculateNextBillingDate,
} from '../src/services/detectionService.js'
import { normalizeMerchant } from '../src/services/merchantNormalizer.js'

test('Merchant Normalizer - correctly strips prefixes, noise, and maps brands', () => {
  // Test common banking prefixes and card noise
  const netflix1 = normalizeMerchant('POS DEBIT - NETFLIX.COM* 1234')
  assert.equal(netflix1.cleanName, 'Netflix')
  assert.equal(netflix1.slug, 'netflix')
  assert.equal(netflix1.category, 'Streaming')

  const spotify = normalizeMerchant('UPI/Spotify AB/Ref#4028')
  assert.equal(spotify.cleanName, 'Spotify')
  assert.equal(spotify.slug, 'spotify')
  assert.equal(spotify.category, 'Music')

  const aws = normalizeMerchant('ACH DEBIT - AMAZON WEB SERVICES')
  assert.equal(aws.cleanName, 'AWS')
  assert.equal(aws.slug, 'aws')
  assert.equal(aws.category, 'Cloud')

  const adobe = normalizeMerchant('ADOBE *CREATIVE CLOUD LLC')
  assert.equal(adobe.cleanName, 'Adobe Creative Cloud')
  assert.equal(adobe.slug, 'adobe')
  assert.equal(adobe.category, 'Software')

  const chatgpt = normalizeMerchant('OPENAI *CHATGPT SUBSCRIPTION')
  assert.equal(chatgpt.cleanName, 'ChatGPT Plus')
  assert.equal(chatgpt.slug, 'chatgpt')
  assert.equal(chatgpt.category, 'SaaS')

  // Similar merchants must be distinguished
  const swiggy = normalizeMerchant('UPI/SWIGGY FOOD DELIVERY')
  assert.equal(swiggy.cleanName, 'Swiggy')
  assert.equal(swiggy.category, 'Food')

  const starbucks = normalizeMerchant('STARBUCKS COFFEE INDIA PVT LTD')
  assert.equal(starbucks.cleanName, 'Starbucks')
  assert.equal(starbucks.category, 'Food')

  assert.notEqual(swiggy.cleanName, starbucks.cleanName)
})

test('Next Billing Date - calendar-aware calculations for monthly and yearly', () => {
  // Reference date: Sep 1, 2026
  const refDate = new Date('2026-09-01T00:00:00Z')

  // Monthly: Aug 14, 2026 -> Sep 14, 2026
  const lastMonthly = new Date('2026-08-14T00:00:00Z')
  const nextMonthly = calculateNextBillingDate(lastMonthly, 'monthly', refDate)
  assert.equal(nextMonthly.getUTCMonth(), 8) // Sep (0-indexed 8)
  assert.equal(nextMonthly.getUTCDate(), 14)

  // Yearly: Aug 20, 2025 -> Aug 20, 2026 (past ref -> rolls to Aug 20, 2027)
  const lastYearly = new Date('2025-08-20T00:00:00Z')
  const nextYearly = calculateNextBillingDate(lastYearly, 'yearly', refDate)
  assert.equal(nextYearly.getUTCFullYear(), 2027)
  assert.equal(nextYearly.getUTCMonth(), 7) // Aug
  assert.equal(nextYearly.getUTCDate(), 20)
})

test('Detection Scenario 1: Repeated monthly payments (e.g. Netflix)', () => {
  const txs = [
    { date: new Date('2026-06-14'), amount: 649, _id: '1' },
    { date: new Date('2026-07-14'), amount: 649, _id: '2' },
    { date: new Date('2026-08-14'), amount: 649, _id: '3' },
  ]

  const result = analyzeMerchantRecurrence(txs, 'Netflix', 'Streaming')
  assert.ok(result, 'Should be detected as recurring subscription')
  assert.equal(result.name, 'Netflix')
  assert.equal(result.billingInterval, 'monthly')
  assert.equal(result.amount, 649)
  assert.equal(result.transactionCount, 3)
  assert.ok(result.confidence >= 0.85, `Confidence was ${result.confidence}, expected >= 0.85`)
  assert.equal(result.status, 'active')
})

test('Detection Scenario 2: Repeated yearly subscription payments (e.g. Annual Cloud/Prime)', () => {
  const txs = [
    { date: new Date('2024-09-10'), amount: 1499, _id: 'y1' },
    { date: new Date('2025-09-11'), amount: 1499, _id: 'y2' },
    { date: new Date('2026-09-10'), amount: 1499, _id: 'y3' },
  ]

  const result = analyzeMerchantRecurrence(txs, 'Amazon Prime', 'Streaming')
  assert.ok(result, 'Should detect yearly subscription')
  assert.equal(result.billingInterval, 'yearly')
  assert.equal(result.amount, 1499)
  assert.ok(result.confidence >= 0.75, `Yearly confidence was ${result.confidence}, expected >= 0.75`)
})

test('Detection Scenario 3: One-time purchases must NOT be detected', () => {
  const txs = [{ date: new Date('2026-08-10'), amount: 4500, _id: 'single1' }]
  const result = analyzeMerchantRecurrence(txs, 'Ikea', 'Shopping')
  assert.equal(result, null, 'Single purchase must never be marked as subscription')
})

test('Detection Scenario 4: Irregular intervals must NOT be detected (e.g. coffee / rides)', () => {
  const txs = [
    { date: new Date('2026-08-01'), amount: 250, _id: 'c1' },
    { date: new Date('2026-08-04'), amount: 250, _id: 'c2' }, // 3 days
    { date: new Date('2026-08-19'), amount: 250, _id: 'c3' }, // 15 days
    { date: new Date('2026-08-22'), amount: 250, _id: 'c4' }, // 3 days
  ]

  const result = analyzeMerchantRecurrence(txs, 'Starbucks', 'Food')
  assert.equal(result, null, 'Irregular interval purchases must not be detected as subscription')
})

test('Detection Scenario 5: Variable amounts must NOT be detected (e.g. food delivery)', () => {
  const txs = [
    { date: new Date('2026-06-15'), amount: 320, _id: 'f1' },
    { date: new Date('2026-07-15'), amount: 1150, _id: 'f2' },
    { date: new Date('2026-08-15'), amount: 480, _id: 'f3' },
  ]

  const result = analyzeMerchantRecurrence(txs, 'Swiggy', 'Food')
  assert.equal(result, null, 'Variable spending must not be detected as subscription')
})

test('Detection Scenario 6: Minor billing-date variations (e.g. 28 vs 31 days)', () => {
  const txs = [
    { date: new Date('2026-05-15'), amount: 119, _id: 'sp1' },
    { date: new Date('2026-06-14'), amount: 119, _id: 'sp2' }, // 30 days
    { date: new Date('2026-07-16'), amount: 119, _id: 'sp3' }, // 32 days
    { date: new Date('2026-08-15'), amount: 119, _id: 'sp4' }, // 30 days
  ]

  const result = analyzeMerchantRecurrence(txs, 'Spotify', 'Music')
  assert.ok(result, 'Minor billing date variations should be detected as monthly subscription')
  assert.equal(result.billingInterval, 'monthly')
  assert.ok(result.confidence >= 0.85)
})

test('Detection Scenario 7: Legitimate subscription price changes', () => {
  const txs = [
    { date: new Date('2026-05-14'), amount: 499, _id: 'p1' },
    { date: new Date('2026-06-14'), amount: 499, _id: 'p2' },
    { date: new Date('2026-07-14'), amount: 649, _id: 'p3' }, // Price increased
    { date: new Date('2026-08-14'), amount: 649, _id: 'p4' },
  ]

  const result = analyzeMerchantRecurrence(txs, 'Netflix', 'Streaming')
  assert.ok(result, 'Should detect subscription with price change')
  assert.equal(result.amount, 649)
  assert.equal(result.previousAmount, 499)
  assert.equal(result.status, 'price_increase')
  assert.ok(result.confidence >= 0.80)
})

test('Detection Scenario 8: Minimum history requirement (insufficient history rejected)', () => {
  const txs = [{ date: new Date('2026-08-01'), amount: 999, _id: 'sub1' }]
  const result = analyzeMerchantRecurrence(txs, 'Notion', 'SaaS')
  assert.equal(result, null, 'Single transaction must have insufficient history')
})
