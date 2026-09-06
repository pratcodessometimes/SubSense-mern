import { categorizeMerchant, normalizeMerchantKey, titleCaseMerchant } from '../utils/normalizeMerchant.js'

const MS_PER_DAY = 1000 * 60 * 60 * 24

const PRICE_HIKE_THRESHOLD = 0.1
const TRIAL_CONVERSION_THRESHOLD = 0.5
const MONTHLY_MIN_DAYS = 20
const MONTHLY_MAX_DAYS = 45
const MONTHLY_EXPECTED_MIN = 28
const MONTHLY_EXPECTED_MAX = 32
const YEARLY_MIN_DAYS = 330
const YEARLY_MAX_DAYS = 400
const UNUSED_DAYS_THRESHOLD = 45

function daysBetween(a, b) {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / MS_PER_DAY)
}

function median(nums) {
  if (nums.length === 0) return 0
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function stdDev(nums) {
  if (nums.length === 0) return 0
  const avg = nums.reduce((s, n) => s + n, 0) / nums.length
  const variance = nums.reduce((s, n) => s + (n - avg) ** 2, 0) / nums.length
  return Math.sqrt(variance)
}

function formatINR(amount) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(
    Math.round(amount),
  )
}

export function runDetection(transactions) {
  const groups = new Map()
  for (const tx of transactions) {
    const key = normalizeMerchantKey(tx.merchant)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(tx)
  }

  const subscriptions = []
  const alerts = []

  for (const [key, txs] of groups.entries()) {
    if (txs.length < 2) continue

    const sorted = [...txs].sort((a, b) => new Date(a.date) - new Date(b.date))
    const intervals = []
    for (let i = 1; i < sorted.length; i++) {
      intervals.push(daysBetween(sorted[i - 1].date, sorted[i].date))
    }
    const avgInterval = intervals.reduce((s, n) => s + n, 0) / intervals.length
    const medInterval = median(intervals)
    const intervalStdDev = stdDev(intervals)

    const isRegularEnough = intervals.length === 1 || intervalStdDev / Math.max(avgInterval, 1) < 0.6
    const looksMonthly = avgInterval >= MONTHLY_MIN_DAYS && avgInterval <= MONTHLY_MAX_DAYS
    const looksYearly = avgInterval >= YEARLY_MIN_DAYS && avgInterval <= YEARLY_MAX_DAYS
    if (!isRegularEnough || (!looksMonthly && !looksYearly)) continue

    const billingInterval = looksYearly ? 'yearly' : 'monthly'
    const last = sorted[sorted.length - 1]
    const prev = sorted[sorted.length - 2]
    const lastAmount = last.amount
    const prevAmount = prev.amount
    const pctChange = prevAmount ? (lastAmount - prevAmount) / prevAmount : 0
    const lastInterval = intervals[intervals.length - 1]

    const name = titleCaseMerchant(last.merchant)
    const category = categorizeMerchant(name)

    const confidenceBase = 0.55 + Math.min(sorted.length, 6) * 0.06 - Math.min(intervalStdDev / 10, 0.15)
    const confidence = Math.max(0.4, Math.min(0.98, confidenceBase))

    const daysSinceLast = daysBetween(last.date, new Date())
    const isUnused = daysSinceLast > UNUSED_DAYS_THRESHOLD

    let priceHike = null
    if (pctChange >= TRIAL_CONVERSION_THRESHOLD) {
      priceHike = { type: 'trial_conversion', pctChange }
    } else if (pctChange >= PRICE_HIKE_THRESHOLD) {
      priceHike = { type: 'price_increase', pctChange }
    }

    let cadenceDrift = null
    if (
      billingInterval === 'monthly' &&
      intervals.length >= 2 &&
      (lastInterval < MONTHLY_EXPECTED_MIN - 3 || lastInterval > MONTHLY_EXPECTED_MAX + 3)
    ) {
      cadenceDrift = { expectedDays: medInterval, actualDays: lastInterval }
    }

    let status = 'active'
    if (isUnused) status = 'unused'
    else if (priceHike) status = 'price_increase'

    subscriptions.push({
      id: key,
      name,
      category,
      amount: lastAmount,
      previousAmount: priceHike ? prevAmount : undefined,
      billingInterval,
      nextBillingDate: new Date(new Date(last.date).getTime() + medInterval * MS_PER_DAY).toISOString(),
      status,
      transactionCount: sorted.length,
      confidence,
      lastActivity: last.date,
      history: sorted.map((t) => ({ date: t.date, amount: t.amount })),
      anomalies: [
        priceHike && { type: priceHike.type, pctChange: priceHike.pctChange },
        cadenceDrift && { type: 'cadence_drift', ...cadenceDrift },
        isUnused && { type: 'unused' },
      ].filter(Boolean),
    })

    if (priceHike) {
      alerts.push({
        id: `${key}-${priceHike.type}`,
        type: priceHike.type,
        severity: priceHike.type === 'trial_conversion' ? 'critical' : 'warning',
        title: priceHike.type === 'trial_conversion' ? 'Trial converted to a paid plan' : 'Price increase detected',
        description:
          priceHike.type === 'trial_conversion'
            ? `${name} jumped from ${formatINR(prevAmount)} to ${formatINR(lastAmount)} — this looks like a free trial converting to a paid subscription.`
            : `Your ${name} subscription increased by ${formatINR(lastAmount - prevAmount)}/${billingInterval === 'yearly' ? 'year' : 'month'}.`,
        subscriptionIds: [key],
        impact: formatINR((lastAmount - prevAmount) * (billingInterval === 'yearly' ? 1 : 12)),
        impactLabel: billingInterval === 'yearly' ? 'Extra cost this year' : 'Potential yearly impact',
      })
    }

    if (cadenceDrift) {
      alerts.push({
        id: `${key}-cadence_drift`,
        type: 'cadence_drift',
        severity: 'warning',
        title: 'Billing cadence shifted',
        description: `${name} usually bills every ~${Math.round(medInterval)} days, but the last cycle was ${lastInterval} days.`,
        subscriptionIds: [key],
        impact: `${lastInterval} days`,
        impactLabel: 'Latest interval',
      })
    }

    if (isUnused) {
      alerts.push({
        id: `${key}-unused`,
        type: 'unused',
        severity: 'critical',
        title: 'Unused subscription',
        description: `No related activity detected recently for ${name}.`,
        subscriptionIds: [key],
        impact: formatINR(lastAmount * (billingInterval === 'yearly' ? 1 : 12)),
        impactLabel: 'Estimated annual cost',
      })
    }
  }

  const byCategory = new Map()
  for (const sub of subscriptions) {
    if (sub.category === 'Other') continue
    if (!byCategory.has(sub.category)) byCategory.set(sub.category, [])
    byCategory.get(sub.category).push(sub)
  }
  for (const [category, subs] of byCategory.entries()) {
    if (subs.length < 2) continue
    for (const sub of subs) {
      if (sub.status === 'active') sub.status = 'duplicate'
    }
    alerts.push({
      id: `duplicate-${category.toLowerCase()}`,
      type: 'duplicate',
      severity: 'warning',
      title: 'Duplicate subscription detected',
      description: `You appear to have ${subs.length} overlapping ${category.toLowerCase()} subscriptions: ${subs.map((s) => s.name).join(', ')}.`,
      subscriptionIds: subs.map((s) => s.id),
      impact: formatINR(subs.reduce((s, x) => s + x.amount, 0)),
      impactLabel: 'Combined monthly cost',
    })
  }

  subscriptions.sort((a, b) => new Date(b.lastActivity) - new Date(a.lastActivity))
  return { subscriptions, alerts }
}
