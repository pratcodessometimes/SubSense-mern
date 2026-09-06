import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Card } from '@/components/ui/Card'
import { formatCurrency } from '@/lib/format'
import { categorySpend, monthlySpend } from '@/lib/mockData'

const projection = [
  { month: 'September', amount: 8420 },
  { month: 'October', amount: 8420 },
  { month: 'November', amount: 8570 },
  { month: 'December', amount: 8570 },
]

const totalCategorySpend = categorySpend.reduce((sum, c) => sum + c.amount, 0)

export function Analytics() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-bold text-ink">Analytics</h1>
        <p className="mt-1 text-base text-ink-muted">Deeper visibility into your recurring spend.</p>
      </div>

      <Card>
        <h2 className="mb-4 text-xl font-semibold text-ink">Spending over time</h2>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={monthlySpend} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="#E5E7EB" />
              <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 12 }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fill: '#6b7280', fontSize: 12 }} width={40} />
              <Tooltip
                formatter={(value) => formatCurrency(Number(value))}
                contentStyle={{ borderRadius: 12, border: '1px solid #E5E7EB', fontSize: 13 }}
                cursor={{ fill: '#EFF6FF' }}
              />
              <Bar dataKey="amount" fill="#2563EB" radius={[6, 6, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-4 text-xl font-semibold text-ink">Category breakdown</h2>
          <div className="flex flex-col gap-3.5">
            {categorySpend
              .sort((a, b) => b.amount - a.amount)
              .map((c) => (
                <div key={c.category}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium text-ink">{c.category}</span>
                    <span className="font-semibold text-ink">{formatCurrency(c.amount)}</span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-canvas">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(c.amount / totalCategorySpend) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
          </div>
        </Card>

        <Card>
          <h2 className="mb-4 text-xl font-semibold text-ink">Monthly projection</h2>
          <p className="mb-3 text-sm text-ink-muted">Expected recurring spend</p>
          <div className="flex flex-col">
            {projection.map((p) => (
              <div key={p.month} className="flex items-center justify-between border-b border-border/60 py-2.5 text-sm last:border-0">
                <span className="text-ink">{p.month}</span>
                <span className="font-semibold text-ink">{formatCurrency(p.amount)}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  )
}
