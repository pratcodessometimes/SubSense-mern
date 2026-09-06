import { Transaction } from '../models/Transaction.js'
import { runDetection } from '../services/detectionEngine.js'

export async function listSubscriptions(req, res) {
  const transactions = await Transaction.find()
  const { subscriptions } = runDetection(transactions)
  res.json(subscriptions)
}

export async function getSubscription(req, res) {
  const transactions = await Transaction.find()
  const { subscriptions } = runDetection(transactions)
  const subscription = subscriptions.find((s) => s.id === req.params.id)
  if (!subscription) return res.status(404).json({ error: 'Subscription not found' })
  res.json(subscription)
}
