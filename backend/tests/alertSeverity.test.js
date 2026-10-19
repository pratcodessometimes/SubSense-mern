// Regression: needs-review inactivity alerts are written with severity 'info'.
// Before Phase 3.3 the Alert schema only allowed 'critical' | 'warning', so
// Alert.create threw and the whole detection run rejected.
// Runs only with the in-memory fake database (npm run test:unit).
import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import { Alert } from '../src/models/Alert.js'
import { syncAlertsForSubscriptions } from '../src/services/detectionService.js'
import { newTestUserId } from './support/testUsers.mjs'

const USER = newTestUserId()

test('Alert schema accepts severity "info" (frontend AlertSeverity already does)', async (t) => {
  if (!mongoose.__isFake) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  const doc = await Alert.create({
    userId: USER,
    type: 'inactivity_review',
    severity: 'info',
    title: 't',
    description: 'd',
    impact: 'i',
    impactLabel: 'l',
  })
  assert.equal(doc.severity, 'info')
  await assert.rejects(
    Alert.create({ userId: USER, type: 'inactivity_review', severity: 'bogus', title: 't', description: 'd', impact: 'i', impactLabel: 'l' }),
    /not a valid enum value/,
  )
})

test('syncAlertsForSubscriptions creates a needs_review alert without throwing', async (t) => {
  if (!mongoose.__isFake) return t.skip('requires the in-memory fake database')
  mongoose.__resetAll()
  const sub = {
    slug: 'sev-test-gym',
    name: 'Sev Test Gym',
    amount: 999,
    billingInterval: 'monthly',
    status: 'needs_review',
    confidence: 0.75,
    lastActivity: new Date('2026-06-01'),
    nextBillingDate: new Date('2026-07-01'),
    daysOverdue: 40,
    daysSinceLastPayment: 70,
  }
  await syncAlertsForSubscriptions(USER, [sub])
  const alerts = await Alert.find({ userId: USER, subscriptionIds: 'sev-test-gym' })
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].subType, 'needs_review')
  assert.equal(alerts[0].severity, 'info')
})
