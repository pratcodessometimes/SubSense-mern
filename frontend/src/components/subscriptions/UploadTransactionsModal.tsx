import { CheckCircle2, Loader2, UploadCloud, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { TransactionFormModal } from '@/components/transactions/TransactionFormModal'
import { Button } from '@/components/ui/Button'
import {
  createTransaction,
  listAlerts,
  listSubscriptions,
  uploadTransactionsFile,
  type ApiAlert,
  type ApiSubscription,
  type TransactionInput,
  type UploadResult,
} from '@/lib/api'

interface UploadTransactionsModalProps {
  onClose: () => void
  onComplete: (subscriptions: ApiSubscription[], alerts: ApiAlert[]) => void
}

const steps = [
  'Parse transactions',
  'Normalize merchant names',
  'Detect recurrence',
  'Find anomalies',
  'Generate insights',
]

const STEP_INTERVAL_MS = 550

export function UploadTransactionsModal({ onClose, onComplete }: UploadTransactionsModalProps) {
  const [dragOver, setDragOver] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [completedSteps, setCompletedSteps] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const stepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return () => {
      if (stepTimerRef.current) clearInterval(stepTimerRef.current)
    }
  }, [])

  async function handleFile(file: File) {
    setError(null)
    setResult(null)
    setProcessing(true)
    setCompletedSteps(0)

    stepTimerRef.current = setInterval(() => {
      setCompletedSteps((c) => (c < steps.length - 1 ? c + 1 : c))
    }, STEP_INTERVAL_MS)

    try {
      const uploadResult = await uploadTransactionsFile(file)
      if (stepTimerRef.current) clearInterval(stepTimerRef.current)
      setCompletedSteps(steps.length)
      setResult(uploadResult)
    } catch (err) {
      if (stepTimerRef.current) clearInterval(stepTimerRef.current)
      setCompletedSteps(0)
      setError(err instanceof Error ? err.message : 'Could not process this file')
    } finally {
      setProcessing(false)
    }
  }

  async function handleManualAdd(input: TransactionInput) {
    await createTransaction(input)
    const [subscriptions, alerts] = await Promise.all([listSubscriptions(), listAlerts()])
    onComplete(subscriptions, alerts)
  }

  function handleDone() {
    if (result) onComplete(result.subscriptions, result.alerts)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={onClose} />
      <div className="relative flex max-h-full w-full max-w-3xl flex-col overflow-y-auto rounded-2xl border border-border bg-surface shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-ink-muted hover:bg-canvas hover:text-ink"
          aria-label="Close"
        >
          <X size={16} />
        </button>

        <div className="px-8 pb-2 pt-8 text-center">
          <h2 className="text-2xl font-bold text-ink">Import transactions</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Upload a transaction history and let SubSense identify recurring payments.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 p-6 md:grid-cols-[1fr_240px]">
          <div className="rounded-xl border border-border bg-surface p-5">
            <h3 className="text-base font-semibold text-ink">Upload your transaction history</h3>
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
              className={`mt-4 flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
                dragOver
                  ? 'border-primary bg-primary-tint'
                  : 'border-primary/30 bg-primary-tint/40 hover:bg-primary-tint/60'
              }`}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.xlsx,.pdf,.docx,.doc"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                }}
              />
              {processing ? (
                <Loader2 size={20} className="animate-spin text-primary" />
              ) : (
                <UploadCloud size={20} className="text-primary" />
              )}
              <div className="text-sm font-semibold text-ink">
                {processing ? 'Uploading…' : 'Drop your files here'}
              </div>
              <div className="text-xs text-ink-muted">or click to browse · CSV, PDF, DOCX up to 15 MB</div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <Button onClick={() => inputRef.current?.click()} disabled={processing}>
                Choose file
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
                  {result.imported} transaction{result.imported === 1 ? '' : 's'} imported
                </div>
                <div className="mt-2 grid grid-cols-2 gap-3 text-center">
                  <div className="rounded-lg bg-canvas p-3">
                    <div className="text-xl font-bold text-ink">{result.subscriptions.length}</div>
                    <div className="text-xs text-ink-muted">subscriptions detected</div>
                  </div>
                  <div className="rounded-lg bg-canvas p-3">
                    <div className="text-xl font-bold text-ink">{result.alerts.length}</div>
                    <div className="text-xs text-ink-muted">alerts flagged</div>
                  </div>
                </div>
                <Button className="mt-4 w-full" onClick={handleDone}>
                  View subscriptions
                </Button>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border bg-surface p-5">
            <h3 className="text-sm font-semibold text-ink">What happens next</h3>
            <ol className="mt-3 flex flex-col gap-3">
              {steps.map((step, i) => {
                const isDone = i < completedSteps || (completedSteps === steps.length && i < steps.length)
                const isActive = processing && i === completedSteps
                return (
                  <li key={step} className="flex items-start gap-2.5 text-sm">
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors ${
                        isDone
                          ? 'bg-positive-tint text-positive'
                          : isActive
                            ? 'bg-primary text-white'
                            : 'bg-primary-tint text-primary'
                      }`}
                    >
                      {isDone ? <CheckCircle2 size={13} /> : isActive ? <Loader2 size={12} className="animate-spin" /> : i + 1}
                    </span>
                    <span className={isDone || isActive ? 'font-medium text-ink' : 'text-ink-muted'}>{step}</span>
                  </li>
                )
              })}
            </ol>
          </div>
        </div>
      </div>

      {manualOpen && (
        <TransactionFormModal
          onClose={() => setManualOpen(false)}
          onSubmit={handleManualAdd}
        />
      )}
    </div>
  )
}
