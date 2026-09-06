import { ArrowRight, Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/Card'
import { formatCurrency } from '@/lib/format'
import { subscriptions } from '@/lib/mockData'

const insights = [
  {
    n: '01',
    text: 'Your subscriptions represent 18% of your monthly spending.',
    cta: 'View breakdown',
    to: '/analytics',
  },
  {
    n: '02',
    text: 'You have 3 subscriptions with potential savings of ₹1,240/month.',
    cta: 'Review savings',
    to: '/alerts',
  },
  {
    n: '03',
    text: 'Netflix increased its price by 30% in August.',
    cta: 'View price history',
    to: '/subscriptions/netflix',
  },
]

const suggestedQuestions = [
  'How much am I spending on streaming?',
  'What subscriptions increased in price?',
  'What can I cancel?',
  'Which subscriptions are unused?',
]

const streaming = subscriptions.filter((s) => s.category === 'Streaming')
const streamingTotal = streaming.reduce((sum, s) => sum + s.amount, 0)

export function AiInsights() {
  const [question, setQuestion] = useState('')
  const [answered, setAnswered] = useState(false)

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-[32px] font-bold text-ink">AI Insights</h1>
        <p className="mt-1 text-base text-ink-muted">Your recurring spending, explained.</p>
      </div>

      <Card>
        <h2 className="mb-2 text-xl font-semibold text-ink">This month</h2>
        <p className="text-sm leading-relaxed text-ink">
          You&apos;re spending <span className="font-semibold">{formatCurrency(8420)}/month</span> on
          recurring services. That&apos;s <span className="font-semibold">{formatCurrency(680)}</span>{' '}
          more than last month. The largest increase came from{' '}
          <span className="font-semibold">Netflix</span> and{' '}
          <span className="font-semibold">Adobe Creative Cloud</span>.
        </p>
      </Card>

      <div>
        <h2 className="mb-3 text-xl font-semibold text-ink">Key insights</h2>
        <div className="flex flex-col gap-3">
          {insights.map((insight) => (
            <Link key={insight.n} to={insight.to}>
              <Card className="flex items-center justify-between transition-shadow hover:shadow-md">
                <div className="flex items-center gap-4">
                  <span className="text-lg font-bold text-primary/40">{insight.n}</span>
                  <p className="text-sm text-ink">{insight.text}</p>
                </div>
                <span className="flex shrink-0 items-center gap-1 text-sm font-semibold text-primary">
                  {insight.cta}
                  <ArrowRight size={14} />
                </span>
              </Card>
            </Link>
          ))}
        </div>
      </div>

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <Sparkles size={18} className="text-primary" />
          <h2 className="text-xl font-semibold text-ink">Ask SubSense</h2>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            setAnswered(true)
          }}
          className="flex items-center gap-2 rounded-xl border border-border bg-canvas p-2"
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="How much am I spending on streaming?"
            className="flex-1 bg-transparent px-2 text-sm text-ink placeholder:text-ink-muted focus:outline-none"
          />
          <button
            type="submit"
            className="flex items-center gap-1 rounded-lg bg-primary px-3.5 py-2 text-sm font-semibold text-white hover:bg-primary-hover"
          >
            Ask <ArrowRight size={14} />
          </button>
        </form>

        <div className="mt-3 flex flex-wrap gap-2">
          {suggestedQuestions.map((q) => (
            <button
              key={q}
              onClick={() => {
                setQuestion(q)
                setAnswered(true)
              }}
              className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-canvas"
            >
              {q}
            </button>
          ))}
        </div>

        {answered && (
          <div className="mt-4 rounded-xl bg-primary-tint p-4">
            <p className="text-sm leading-relaxed text-ink">
              You currently spend <span className="font-semibold">{formatCurrency(streamingTotal)}/month</span> on
              streaming services.
            </p>
            <div className="mt-3 flex flex-col gap-1.5">
              {streaming.map((s) => (
                <div key={s.id} className="flex items-center justify-between text-sm">
                  <span className="text-ink">{s.name}</span>
                  <span className="font-medium text-ink">{formatCurrency(s.amount)}</span>
                </div>
              ))}
            </div>
            <p className="mt-3 text-sm text-ink-muted">
              {streaming[0]?.name} accounts for{' '}
              {Math.round(((streaming[0]?.amount ?? 0) / streamingTotal) * 100)}% of your streaming
              spend.
            </p>
          </div>
        )}
      </Card>
    </div>
  )
}
