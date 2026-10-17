import { Loader2, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('All')

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

  const categories = useMemo(() => {
    const set = new Set<string>()
    transactions.forEach((tx) => {
      if (tx.category) set.add(tx.category)
    })
    return ['All', ...Array.from(set)]
  }, [transactions])

  const filteredTransactions = useMemo(() => {
    return transactions.filter((tx) => {
      const matchesCategory = category === 'All' || tx.category === category
      const q = query.toLowerCase().trim()
      const matchesQuery =
        !q ||
        tx.merchant.toLowerCase().includes(q) ||
        (tx.account && tx.account.toLowerCase().includes(q)) ||
        (tx.category && tx.category.toLowerCase().includes(q))
      return matchesCategory && matchesQuery
    })
  }, [transactions, category, query])

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
          <h1 className="text-[32px] font-bold text-ink">Transactions</h1>
          <p className="mt-1 text-base text-ink-muted">
            {loading ? 'Loading…' : `${transactions.length} transactions analyzed`}
          </p>
        </div>
        <div className="flex gap-3">
          <Link to="/upload">
            <Button variant="secondary" icon={<Upload size={16} />}>
              Upload CSV
            </Button>
          </Link>
          <Button
            id="manual-entry-button"
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

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={
                c === category
                  ? 'rounded-full bg-primary px-3.5 py-1.5 text-sm font-semibold text-white'
                  : 'rounded-full border border-border bg-surface px-3.5 py-1.5 text-sm font-medium text-ink-muted hover:bg-canvas'
              }
            >
              {c}
            </button>
          ))}
        </div>
        <div className="relative w-full sm:w-64">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted" />
          <input
            id="transaction-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            type="text"
            placeholder="Search transactions..."
            className="w-full rounded-lg border border-border bg-surface py-2 pl-9 pr-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-tint"
          />
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
      ) : filteredTransactions.length === 0 ? (
        <Card className="py-12 text-center text-sm text-ink-muted">
          No matching transactions found.
        </Card>
      ) : (
        <Card className="p-0">
          <div className="grid grid-cols-[100px_1fr_110px_100px_150px_100px_80px] gap-3 border-b border-border px-5 py-3 text-xs font-medium uppercase tracking-wide text-ink-muted">
            <span>Date</span>
            <span>Merchant</span>
            <span>Category</span>
            <span className="text-right">Amount</span>
            <span>Account</span>
            <span>Status</span>
            <span className="text-right">Actions</span>
          </div>
          {filteredTransactions.map((tx) => (
            <div
              key={tx._id}
              className="grid grid-cols-[100px_1fr_110px_100px_150px_100px_80px] items-center gap-3 border-b border-border/60 px-5 py-3.5 text-sm last:border-0 hover:bg-canvas"
            >
              <span className="text-ink-muted">{formatDate(tx.date)}</span>
              <span className="font-medium text-ink">{tx.merchant}</span>
              <span className="text-xs text-ink-muted">{tx.category || 'General'}</span>
              <span className="text-right font-medium text-ink">{formatCurrency(tx.amount)}</span>
              <span className="truncate text-xs text-ink-muted">{tx.account}</span>
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
                  className="delete-tx-button flex h-7 w-7 items-center justify-center rounded-md text-ink-muted hover:bg-danger-tint hover:text-danger disabled:opacity-50"
                  aria-label={`Delete ${tx.merchant}`}
                >
                  {deletingId === tx._id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                </button>
              </span>
            </div>
          ))}
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
