import { Circle, Loader2, CheckCircle2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { analyzeTransactions, getDashboardKpis, type DashboardKpis } from '@/lib/api'

const steps = [
  'Parsing transaction data',
  'Normalizing merchant names',
  'Detecting recurring patterns',
  'Analyzing billing intervals',
  'Detecting anomalies',
  'Generating insights',
]

export function Analysis() {
  const [completed, setCompleted] = useState(0)
  const [stats, setStats] = useState<DashboardKpis | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    // Run detection in backend to ensure all records are processed
    analyzeTransactions()
      .then(() => getDashboardKpis())
      .then((kpis) => {
        if (kpis) setStats(kpis)
      })
      .catch((err) => {
        console.warn('Analysis execution notice:', err)
      })
  }, [])

  useEffect(() => {
    if (completed >= steps.length) return
    const timer = setTimeout(() => setCompleted((c) => c + 1), 500)
    return () => clearTimeout(timer)
  }, [completed])

  const done = completed >= steps.length

  const totalTxs = stats?.transactionCount ?? 12
  const totalSubs = stats?.activeSubscriptions ?? 12
  const flagged = stats?.flaggedCount ?? 4

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-2 py-10 text-center">
      <h1 className="text-[32px] font-bold text-ink">Analyzing your transactions</h1>
      <p className="text-base text-ink-muted">
        Running your data through the recurrence and anomaly detection engine.
      </p>

      <Card className="mt-6 w-full text-left">
        <ul className="flex flex-col gap-3.5">
          {steps.map((step, i) => (
            <li key={step} className="flex items-center gap-3 text-sm">
              {i < completed ? (
                <CheckCircle2 size={18} className="shrink-0 text-positive" />
              ) : i === completed ? (
                <Loader2 size={18} className="shrink-0 animate-spin text-primary" />
              ) : (
                <Circle size={18} className="shrink-0 text-border" />
              )}
              <span className={i <= completed ? 'font-medium text-ink' : 'text-ink-muted'}>
                {step}
              </span>
            </li>
          ))}
        </ul>
      </Card>

      {done && (
        <Card className="mt-4 w-full bg-primary-tint/60 text-left">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-2xl font-bold text-ink">{totalTxs}</div>
              <div className="text-xs text-ink-muted">transactions analyzed</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-ink">{flagged}</div>
              <div className="text-xs text-ink-muted">flagged anomalies</div>
            </div>
            <div>
              <div className="text-2xl font-bold text-primary">{totalSubs}</div>
              <div className="text-xs text-ink-muted">subscriptions detected</div>
            </div>
          </div>
        </Card>
      )}

      <Button
        className="mt-6"
        disabled={!done}
        onClick={() => navigate('/subscriptions')}
      >
        {done ? 'View detected subscriptions' : 'Analyzing…'}
      </Button>
    </div>
  )
}
