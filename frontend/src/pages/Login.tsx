import { AlertTriangle, ArrowRight, Wallet } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { formatCurrency } from '@/lib/format'
import { kpis } from '@/lib/mockData'

export function Login() {
  const navigate = useNavigate()

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      <div className="flex flex-col justify-center px-10 py-16 sm:px-16 lg:px-20">
        <div className="mb-10 flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-white">
            <Wallet size={20} />
          </div>
          <span className="text-xl font-bold text-ink">SubSense</span>
        </div>

        <h1 className="max-w-md text-[32px] font-bold leading-tight text-ink">
          Know where your recurring money goes.
        </h1>
        <p className="mt-4 max-w-md text-base leading-relaxed text-ink-muted">
          Automatically detect subscriptions, spot hidden price increases, and understand your
          recurring spending — grounded in your real transaction data, not guesswork.
        </p>

        <div className="mt-8 flex items-center gap-3">
          <Button onClick={() => navigate('/dashboard')} icon={<ArrowRight size={16} />}>
            Get Started
          </Button>
          <Button variant="secondary">Sign in</Button>
        </div>
      </div>

      <div className="hidden items-center justify-center bg-ink px-16 py-16 lg:flex">
        <div className="w-full max-w-sm">
          <Card className="bg-surface/95 backdrop-blur">
            <span className="text-sm font-medium text-ink-muted">Monthly recurring spend</span>
            <div className="mt-2 text-[36px] font-bold leading-none text-ink">
              {formatCurrency(kpis.monthlySpend)}
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-canvas p-3">
                <div className="text-xl font-bold text-ink">{kpis.activeSubscriptions}</div>
                <div className="text-xs text-ink-muted">subscriptions</div>
              </div>
              <div className="rounded-xl bg-danger-tint p-3">
                <div className="flex items-center gap-1 text-xl font-bold text-danger">
                  <AlertTriangle size={16} />
                  {kpis.alertCount}
                </div>
                <div className="text-xs text-danger/80">alerts</div>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
