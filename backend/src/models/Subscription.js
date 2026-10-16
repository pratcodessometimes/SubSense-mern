import mongoose from 'mongoose'

const subscriptionSchema = new mongoose.Schema(
  {
    slug: { type: String, trim: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    previousAmount: { type: Number, min: 0 },
    billingInterval: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
    nextBillingDate: { type: Date, required: true },
    status: {
      type: String,
      enum: [
        'active',
        'price_increase',
        'potentially_inactive',
        'needs_review',
        'confirmed_cancelled',
        'duplicate',
        'unused',
      ],
      default: 'active',
    },
    transactionCount: { type: Number, default: 1 },
    confidence: { type: Number, default: 0.85, min: 0, max: 1 },
    lastActivity: { type: Date },
    notes: { type: String, trim: true },
    priceChangePct: { type: Number },
    monthlyDifference: { type: Number },
    annualImpact: { type: Number },
    priceIncreaseDate: { type: Date },
    serviceDomain: { type: String, trim: true },
    hasDuplicateCharges: { type: Boolean, default: false },
    duplicateAmount: { type: Number, min: 0 },
    duplicateConfidence: {
      type: String,
      enum: ['high', 'medium', 'suspected'],
      default: 'high',
    },
    duplicateAccounts: [{ type: String, trim: true }],
    overlappingWith: [{ type: String, trim: true }],
    daysSinceLastPayment: { type: Number, min: 0 },
    daysOverdue: { type: Number },
    inactivityReason: { type: String, trim: true },
    inactivityEvidence: { type: String, trim: true },
  },
  { timestamps: true },
)

export const Subscription = mongoose.model('Subscription', subscriptionSchema)
