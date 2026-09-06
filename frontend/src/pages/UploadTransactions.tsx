import { CheckCircle2, Loader2, UploadCloud } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { TransactionFormModal } from '@/components/transactions/TransactionFormModal'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { formatCurrency, formatDate } from '@/lib/format'
import { createTransaction, importTransactionsCsv, type ApiTransaction, type TransactionInput } from '@/lib/api'

const steps = [
  'Parse transactions',
  'Normalize merchant names',
  'Detect recurrence',
  'Find anomalies',
  'Generate insights',
]

export function UploadTransactions() {
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{ count: number; transactions: ApiTransaction[] } | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleFile(file: File) {
    setError(null)
    setUploading(true)
    try {
      setResult(await importTransactionsCsv(file))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not import this CSV')
    } finally {
      setUploading(false)
    }
  }

  async function handleManualAdd(input: TransactionInput) {
    const transaction = await createTransaction(input)
    setResult((prev) =>
      prev
        ? { count: prev.count + 1, transactions: [transaction, ...prev.transactions] }
        : { count: 1, transactions: [transaction] },
    )
  }

  const preview = result?.transactions.slice(0, 5) ?? []

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-2 py-2">
      <div className="text-center">
        <h1 className="text-[32px] font-bold text-ink">Import transactions</h1>
        <p className="mt-1 text-base text-ink-muted">
          Upload a transaction history and let SubSense identify recurring payments.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 md:grid-cols-[1fr_260px]">
        <Card>
          <h2 className="text-base font-semibold text-ink">Upload your transaction history</h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            We analyze merchant names, amounts, and billing intervals.
          </p>

          <div
            onDragOver={(e) => {
              e.preventDefault()
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const file = e.dataTransfer.files[0]
              if (file) handleFile(file)
            }}
            onClick={() => inputRef.current?.click()}
            className={`mt-4 flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-8 py-12 text-center transition-colors ${
              dragOver ? 'border-primary bg-primary-tint' : 'border-primary/30 bg-primary-tint/40 hover:bg-primary-tint/60'
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) handleFile(file)
              }}
            />
            {uploading ? (
              <Loader2 size={20} className="animate-spin text-primary" />
            ) : (
              <UploadCloud size={20} className="text-primary" />
            )}
            <div className="text-sm font-semibold text-ink">
              {uploading ? 'Uploading…' : 'Drop your CSV here'}
            </div>
            <div className="text-xs text-ink-muted">or click to browse · CSV up to 10 MB</div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button onClick={() => inputRef.current?.click()} disabled={uploading}>
              Choose CSV file
            </Button>
            <span className="text-sm text-ink-muted">Need a quick test?</span>
            <Button variant="secondary" onClick={() => setManualOpen(true)}>
              Add manually
            </Button>
          </div>

          {error && (
            <div className="mt-4 rounded-lg border border-danger/30 bg-danger-tint px-4 py-3 text-sm text-danger">
              {error}
            </div>
          )}

          {result && (
            <div className="mt-5 border-t border-border pt-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-positive">
                <CheckCircle2 size={16} />
                {result.count} transaction{result.count === 1 ? '' : 's'} added
              </div>

              {preview.length > 0 && (
                <div className="mt-3 flex flex-col">
                  <div className="grid grid-cols-3 border-b border-border pb-2 text-xs font-medium uppercase tracking-wide text-ink-muted">
                    <span>Date</span>
                    <span>Merchant</span>
                    <span className="text-right">Amount</span>
                  </div>
                  {preview.map((tx) => (
                    <div key={tx._id} className="grid grid-cols-3 border-b border-border/60 py-2.5 text-sm last:border-0">
                      <span className="text-ink-muted">{formatDate(tx.date)}</span>
                      <span className="font-medium text-ink">{tx.merchant}</span>
                      <span className="text-right font-medium text-ink">{formatCurrency(tx.amount)}</span>
                    </div>
                  ))}
                </div>
              )}

              <Button className="mt-4 w-full sm:w-auto" onClick={() => navigate('/analysis')}>
                Analyze Transactions
              </Button>
            </div>
          )}
        </Card>

        <Card>
          <h2 className="text-sm font-semibold text-ink">What happens next</h2>
          <ol className="mt-3 flex flex-col gap-3">
            {steps.map((step, i) => (
              <li key={step} className="flex items-start gap-2.5 text-sm text-ink-muted">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-tint text-xs font-semibold text-primary">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </Card>
      </div>

      {manualOpen && (
        <TransactionFormModal onClose={() => setManualOpen(false)} onSubmit={handleManualAdd} />
      )}
    </div>
  )
}
