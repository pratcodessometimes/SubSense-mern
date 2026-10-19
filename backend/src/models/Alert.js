import mongoose from 'mongoose'

const alertSchema = new mongoose.Schema(
  {
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
    // anomalyKey = "payment_anomaly:<subscription slug>:<transaction id>" makes upserts idempotent;
    // the sparse unique index lets every non-anomaly alert omit it.
    anomalyKey: { type: String, trim: true, index: { unique: true, sparse: true } },
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

export const Alert = mongoose.model('Alert', alertSchema)
