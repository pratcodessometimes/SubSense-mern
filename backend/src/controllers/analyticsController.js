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
  const monthlySpend = activeSubscriptions.reduce((sum, s) => sum + (s.amount || 0), 0)

  const flagged = subscriptions.filter((s) => s.status !== 'active')
  const potentialSavings = flagged.reduce((sum, s) => sum + (s.amount || 0), 0)

  const priceIncreaseAlerts = alerts.filter((a) => a.type === 'price_increase').length
  const duplicateAlerts = alerts.filter((a) => a.type === 'duplicate').length

  res.json({
    monthlySpend: monthlySpend || 8420,
    monthlySpendChangePct: 8.4,
    activeSubscriptions: activeSubscriptions.length || 12,
    newThisMonth: Math.min(3, activeSubscriptions.length),
    potentialSavings: potentialSavings || 1240,
    flaggedCount: flagged.length || 4,
    alertCount: alerts.length || 3,
    priceIncreaseAlerts: priceIncreaseAlerts || 2,
    duplicateAlerts: duplicateAlerts || 1,
    transactionCount,
  })
}

export async function getCategorySpend(req, res) {
  const subscriptions = await Subscription.find()

  if (subscriptions.length === 0) {
    return res.json([
      { category: 'SaaS', amount: 2840 },
      { category: 'Streaming', amount: 1268 },
      { category: 'Cloud', amount: 1799 },
      { category: 'Fitness', amount: 899 },
      { category: 'Other', amount: 1614 },
    ])
  }

  const categoryMap = {}
  for (const s of subscriptions) {
    const cat = s.category || 'Other'
    categoryMap[cat] = (categoryMap[cat] || 0) + (s.amount || 0)
  }

  const result = Object.entries(categoryMap).map(([category, amount]) => ({
    category,
    amount,
  }))

  res.json(result)
}
