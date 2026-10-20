import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatCompactCurrency, formatCurrency } from '@/lib/format'
import type { MonthlyActualPoint } from '@/lib/api'

interface Props {
  /** Recorded recurring payments per month, exactly as returned by GET /api/analytics/monthly. */
  data: MonthlyActualPoint[]
  variant?: 'bar' | 'area'
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: MonthlyActualPoint }> }) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  return (
    <div className="rounded-xl border border-border bg-surface px-3 py-2 text-[13px] shadow-sm">
      <div className="font-semibold text-ink">{point.label}</div>
      {point.paymentCount === 0 ? (
        <div className="text-ink-muted">No recurring payments recorded</div>
      ) : (
        <>
          <div className="text-ink">{formatCurrency(point.amount)}</div>
          <div className="text-xs text-ink-muted">
            {point.paymentCount} payment{point.paymentCount === 1 ? '' : 's'} · {point.subscriptionCount} subscription
            {point.subscriptionCount === 1 ? '' : 's'}
          </div>
        </>
      )}
    </div>
  )
}

/** Shared by the Dashboard and Analytics pages so both always show the same backend series. */
export function MonthlySpendChart({ data, variant = 'bar' }: Props) {
  const axisTick = { fill: '#6b7280', fontSize: 12 }
  const chartData = data.map((d) => ({ ...d, short: d.label.replace(/ (\d{2})(\d{2})$/, " '$2") }))

  return (
    <div className="h-56 w-full sm:h-64" role="img" aria-label={`Recorded recurring payments for ${data.length} months`}>
      <ResponsiveContainer width="100%" height="100%">
        {variant === 'area' ? (
          <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="spendGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2563EB" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#2563EB" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="short" axisLine={false} tickLine={false} tick={axisTick} minTickGap={12} />
            <YAxis axisLine={false} tickLine={false} tick={axisTick} width={52} tickFormatter={formatCompactCurrency} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="amount" stroke="#2563EB" strokeWidth={2.5} fill="url(#spendGradient)" />
          </AreaChart>
        ) : (
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="#E5E7EB" />
            <XAxis dataKey="short" axisLine={false} tickLine={false} tick={axisTick} minTickGap={8} />
            <YAxis axisLine={false} tickLine={false} tick={axisTick} width={52} tickFormatter={formatCompactCurrency} />
            <Tooltip content={<ChartTooltip />} cursor={{ fill: '#EFF6FF' }} />
            <Bar dataKey="amount" fill="#2563EB" radius={[6, 6, 0, 0]} />
          </BarChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}
