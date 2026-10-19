import mongoose from 'mongoose'

const alertSchema = new mongoose.Schema(
  {
    // Phase 4.1: owning user. Set only by the server from the authenticated session.
    // Legacy documents created before authentication have no userId and are therefore
    // invisible to every user-scoped query until explicitly migrated.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    type: {
      type: String,
      enum: ['price_increase', 'duplicate', 'unused', 'service_overlap', 'inactivity_review', 'payment_anomaly'],
      required: true,
    },
    severity: {
      type: String,
      // 'info' is written for needs_review inactivity alerts (Phase 3.3 fix; frontend already supports it)
      enum: ['critical', 'warning', 'info'],
      default: 'warning',
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    subscriptionIds: [{ type: String, trim: true }],
    impact: { type: String, required: true, trim: true },
    impactLabel: { type: String, required: true, trim: true },
    previousAmount: { type: Number, min: 0 },
    currentAmount: { type: Number, min: 0 },
    percentageChange: { type: Number },
    monthlyImpact: { type: Number },
    annualImpact: { type: Number },
    subType: {
      type: String,
      enum: [
        'confirmed_duplicate',
        'suspected_duplicate',
        'service_overlap',
        'potentially_inactive',
        'needs_review',
        'unusual_amount',
        'unusual_timing',
      ],
    },
    serviceDomain: { type: String, trim: true },
    duplicateAccounts: [{ type: String, trim: true }],
    daysSinceLastPayment: { type: Number },
    daysOverdue: { type: Number },
    expectedBillingDate: { type: Date },
    lastPaymentDate: { type: Date },
    confidenceLabel: { type: String, trim: true },
    isManual: { type: Boolean, default: false },

    // Phase 3.3 — payment anomaly alerts (all optional; existing documents stay valid).
    // anomalyKey = "payment_anomaly:<subscription slug>:<transaction id>" makes upserts idempotent.
    // Phase 4.1: uniqueness is per user (compound index below), so two users can hold the same key.
    anomalyKey: { type: String, trim: true },
    transactionId: { type: String, trim: true },
    anomalyReason: { type: String, trim: true },
    anomalyScore: { type: Number },
    expectedAmount: { type: Number },
    expectedIntervalDays: { type: Number },
    actualIntervalDays: { type: Number },
    paymentDate: { type: Date },
    detectorVersion: { type: String, trim: true },
  },
  { timestamps: true },
)

alertSchema.index({ userId: 1, createdAt: -1 })
// Replaces the Phase 3.3 global `anomalyKey_1` unique index. A partial filter (not `sparse`)
// is required: with a compound key, `sparse` would still index every alert that has a userId
// and make all non-anomaly alerts of a user collide on { anomalyKey: null }.
// The old global index is NOT dropped automatically — see backend/docs/PHASE_4_1_AUTH_AND_ISOLATION.md.
alertSchema.index(
  { userId: 1, anomalyKey: 1 },
  { unique: true, partialFilterExpression: { anomalyKey: { $type: 'string' } }, name: 'userId_1_anomalyKey_1' },
)

export const Alert = mongoose.model('Alert', alertSchema)
