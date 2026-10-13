import mongoose from 'mongoose'

const alertSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['price_increase', 'duplicate', 'unused'],
      required: true,
    },
    severity: {
      type: String,
      enum: ['critical', 'warning'],
      default: 'warning',
    },
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    subscriptionIds: [{ type: String, trim: true }],
    impact: { type: String, required: true, trim: true },
    impactLabel: { type: String, required: true, trim: true },
  },
  { timestamps: true },
)

export const Alert = mongoose.model('Alert', alertSchema)
