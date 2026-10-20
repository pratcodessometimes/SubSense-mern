import { Loader2, Pencil, Plus, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { TransactionFormModal } from '@/components/transactions/TransactionFormModal'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/format'
import {
  createTransaction,
  deleteTransaction,
  listTransactions,
  updateTransaction,
  type ApiTransaction,
  type TransactionInput,
} from '@/lib/api'

export function Transactions() {
  const [transactions, setTransactions] = useState<ApiTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<ApiTransaction | undefined>(undefined)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      setTransactions(await listTransactions())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load transactions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function handleCreate(input: TransactionInput) {
    await createTransaction(input)
    await refresh()
  }

  async function handleUpdate(input: TransactionInput) {
    if (!editing) return
    await updateTransaction(editing._id, input)
    await refresh()
  }

  async function handleDelete(id: string) {
    if (!confirm('Delete this transaction?')) return
    setDeletingId(id)
    try {
      await deleteTransaction(id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete transaction')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-[28px] font-bold text-ink sm:text-[32px]">Transactions</h1>
          <p className="mt-1 text-base text-ink-muted">
            {loading ? 'Loading…' : `${transactions.length} transactions analyzed`}
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link to="/upload">
            <Button variant="secondary" icon={<Upload size={16} />}>
              Upload CSV
            </Button>
          </Link>
          <Button
            icon={<Plus size={16} />}
            onClick={() => {
              setEditing(undefined)
              setModalOpen(true)
            }}
          >
            Manual Entry
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger-tint px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-ink-muted">
          <Loader2 size={18} className="animate-spin" />
          Loading transactions…
        </div>
      ) : transactions.length === 0 ? (
        <Card className="py-12 text-center text-sm text-ink-muted">
          No transactions yet. Add one manually or upload a CSV to get started.
        </Card>
      ) : (
        <Card className="p-0">
          {/* Phase 5.1: on narrow screens the table scrolls inside the card, never the whole page. */}
          <div className="overflow-x-auto" role="region" aria-label="Transactions table" tabIndex={0}>
          <div className="min-w-[760px]">
          <div className="grid grid-cols-[100px_1fr_120px_160px_120px_80px] gap-4 border-b border-border px-5 py-3 text-xs font-medium uppercase tracking-wide text-ink-muted">
            <span>Date</span>
            <span>Merchant</span>
            <span className="text-right">Amount</span>
            <span>Account</span>
            <span>Status</span>
            <span className="text-right">Actions</span>
          </div>
          {transactions.map((tx) => (
            <div
              key={tx._id}
              className="grid grid-cols-[100px_1fr_120px_160px_120px_80px] items-center gap-4 border-b border-border/60 px-5 py-3.5 text-sm last:border-0 hover:bg-canvas"
            >
              <span className="text-ink-muted">{formatDate(tx.date)}</span>
              <span className="font-medium text-ink">{tx.merchant}</span>
              <span className="text-right font-medium text-ink">{formatCurrency(tx.amount)}</span>
              <span className="text-ink-muted">{tx.account}</span>
              <span>
                {tx.isRecurring ? <Badge tone="primary">Recurring</Badge> : <Badge>One-time</Badge>}
              </span>
              <span className="flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => {
                    setEditing(tx)
                    setModalOpen(true)
                  }}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-canvas hover:text-ink"
                  aria-label={`Edit ${tx.merchant}`}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(tx._id)}
                  disabled={deletingId === tx._id}
                  className="flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-danger-tint hover:text-danger disabled:opacity-50"
                  aria-label={`Delete ${tx.merchant}`}
                >
                  {deletingId === tx._id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
              </span>
            </div>
          ))}
          </div>
          </div>
        </Card>
      )}

      {modalOpen && (
        <TransactionFormModal
          initial={editing}
          onClose={() => setModalOpen(false)}
          onSubmit={editing ? handleUpdate : handleCreate}
        />
      )}
    </div>
  )
}
