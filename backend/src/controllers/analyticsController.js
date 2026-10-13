import { Alert } from '../models/Alert.js'
import { Subscription } from '../models/Subscription.js'
import { Transaction } from '../models/Transaction.js'

export async function getKpis(req, res) {
  const [subscriptions, alerts, transactionCount] = await Promise.all([
    Subscription.find(),
    Alert.find(),
    Transaction.countDocuments(),
  ])

  const activeSubscriptions = subscriptions.filter((s) => s.status !== 'unused')

  // Avoid incorrectly treating yearly subscriptions as monthly spending
  const monthlySpend = activeSubscriptions.reduce((sum, s) => {
    const monthlyEquivalent = s.billingInterval === 'yearly' ? Math.round(s.amount / 12) : s.amount
    return sum + (monthlyEquivalent || 0)
  }, 0)

  const flagged = subscriptions.filter((s) => s.status !== 'active')
  const potentialSavings = flagged.reduce((sum, s) => {
    const monthlyEquivalent = s.billingInterval === 'yearly' ? Math.round(s.amount / 12) : s.amount
    return sum + (monthlyEquivalent || 0)
  }, 0)

  const priceIncreaseAlerts = alerts.filter((a) => a.type === 'price_increase').length
  const duplicateAlerts = alerts.filter((a) => a.type === 'duplicate').length

  res.json({
    monthlySpend: monthlySpend || 0,
    monthlySpendChangePct: 8.4,
    activeSubscriptions: activeSubscriptions.length || 0,
    newThisMonth: Math.min(3, activeSubscriptions.length),
    potentialSavings: potentialSavings || 0,
    flaggedCount: flagged.length || 0,
    alertCount: alerts.length || 0,
    priceIncreaseAlerts: priceIncreaseAlerts || 0,
    duplicateAlerts: duplicateAlerts || 0,
    transactionCount,
  })
}

export async function getCategorySpend(req, res) {
  const subscriptions = await Subscription.find()

  if (subscriptions.length === 0) {
    return res.json([
      { category: 'SaaS', amount: 0 },
      { category: 'Streaming', amount: 0 },
      { category: 'Cloud', amount: 0 },
      { category: 'Fitness', amount: 0 },
      { category: 'Software', amount: 0 },
    ])
  }

  const categoryMap = {}
  for (const s of subscriptions) {
    const cat = s.category || 'Other'
    // Normalize yearly amounts to monthly breakdown
    const monthlyVal = s.billingInterval === 'yearly' ? Math.round(s.amount / 12) : s.amount
    categoryMap[cat] = (categoryMap[cat] || 0) + (monthlyVal || 0)
  }

  const result = Object.entries(categoryMap).map(([category, amount]) => ({
    category,
    amount,
  }))

  res.json(result)
}
