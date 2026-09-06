import { Transaction } from '../models/Transaction.js'
import { runDetection } from '../services/detectionEngine.js'

export async function listAlerts(req, res) {
  const transactions = await Transaction.find()
  const { alerts } = runDetection(transactions)
  res.json(alerts)
}
