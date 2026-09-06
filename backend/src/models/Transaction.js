import mongoose from 'mongoose'

const transactionSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    merchant: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    account: { type: String, trim: true, default: 'Manual Entry' },
    type: { type: String, trim: true, default: 'expense' },
    isRecurring: { type: Boolean, default: false },
    notes: { type: String, trim: true },
  },
  { timestamps: true },
)

export const Transaction = mongoose.model('Transaction', transactionSchema)
