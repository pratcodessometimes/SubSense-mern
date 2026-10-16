import { Alert } from '../models/Alert.js'

export async function listAlerts(req, res) {
  const alerts = await Alert.find().sort({ createdAt: -1 })
  res.json(alerts)
}

export async function createAlert(req, res) {
  const {
    type,
    severity,
    title,
    description,
    subscriptionIds,
    impact,
    impactLabel,
    previousAmount,
    currentAmount,
    percentageChange,
    monthlyImpact,
    annualImpact,
    subType,
    serviceDomain,
    duplicateAccounts,
    daysSinceLastPayment,
    daysOverdue,
    expectedBillingDate,
    lastPaymentDate,
    confidenceLabel,
    isManual,
  } = req.body

  if (!type || !title || !description || !impact || !impactLabel) {
    return res.status(400).json({ error: 'type, title, description, impact and impactLabel are required' })
  }

  const alert = await Alert.create({
    type,
    severity: severity || 'warning',
    title,
    description,
    subscriptionIds: subscriptionIds || [],
    impact,
    impactLabel,
    previousAmount,
    currentAmount,
    percentageChange,
    monthlyImpact,
    annualImpact,
    subType,
    serviceDomain,
    duplicateAccounts: duplicateAccounts || [],
    daysSinceLastPayment,
    daysOverdue,
    expectedBillingDate,
    lastPaymentDate,
    confidenceLabel,
    isManual: isManual !== undefined ? isManual : true,
  })

  res.status(201).json(alert)
}

export async function deleteAlert(req, res) {
  const alert = await Alert.findByIdAndDelete(req.params.id)
  if (!alert) return res.status(404).json({ error: 'Alert not found' })
  res.status(204).send()
}
