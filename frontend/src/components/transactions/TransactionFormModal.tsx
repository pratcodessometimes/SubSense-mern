import { useState, type FormEvent } from 'react'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import type { ApiTransaction, TransactionInput } from '@/lib/api'

interface TransactionFormModalProps {
  initial?: ApiTransaction
  onClose: () => void
  onSubmit: (input: TransactionInput) => Promise<void>
}

function toDateInputValue(iso?: string) {
  if (!iso) return new Date().toISOString().slice(0, 10)
  return new Date(iso).toISOString().slice(0, 10)
}

export function TransactionFormModal({ initial, onClose, onSubmit }: TransactionFormModalProps) {
  const [date, setDate] = useState(toDateInputValue(initial?.date))
  const [merchant, setMerchant] = useState(initial?.merchant ?? '')
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '')
  const [account, setAccount] = useState(initial?.account ?? '')
  const [isRecurring, setIsRecurring] = useState(initial?.isRecurring ?? false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isEdit = Boolean(initial)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)

    const parsedAmount = Number(amount)
    if (!merchant.trim() || !date || Number.isNaN(parsedAmount) || parsedAmount <= 0) {
      setError('Please enter a valid merchant, date, and amount.')
      return
    }

    setSubmitting(true)
    try {
      await onSubmit({
        date,
        merchant: merchant.trim(),
        amount: parsedAmount,
        account: account.trim() || undefined,
        isRecurring,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal title={isEdit ? 'Edit transaction' : 'Add transaction'} onClose={onClose}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted" htmlFor="tx-merchant">
            Merchant
          </label>
          <input
            id="tx-merchant"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            placeholder="e.g. Netflix"
            className="rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-tint"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-muted" htmlFor="tx-amount">
              Amount (₹)
            </label>
            <input
              id="tx-amount"
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="649"
              className="rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-tint"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-ink-muted" htmlFor="tx-date">
              Date
            </label>
            <input
              id="tx-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-tint"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-muted" htmlFor="tx-account">
            Account <span className="text-ink-muted/70">(optional)</span>
          </label>
          <input
            id="tx-account"
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder="HDFC •••• 2814"
            className="rounded-lg border border-border bg-canvas px-3 py-2 text-sm text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-tint"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            checked={isRecurring}
            onChange={(e) => setIsRecurring(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          This is a recurring payment
        </label>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="mt-1 flex items-center justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : isEdit ? 'Save changes' : 'Add transaction'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
