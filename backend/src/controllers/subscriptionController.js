import { Subscription } from '../models/Subscription.js'

export async function listSubscriptions(req, res) {
  const { category, status } = req.query
  const filter = {}
  if (category && category !== 'All') filter.category = category
  if (status) filter.status = status

  const subs = await Subscription.find(filter).sort({ amount: -1 })
  res.json(subs)
}

export async function getSubscription(req, res) {
  const { id } = req.params
  let sub = null
  if (id.match(/^[0-9a-fA-F]{24}$/)) {
    sub = await Subscription.findById(id)
  }
  if (!sub) {
    sub = await Subscription.findOne({ slug: id })
  }
  if (!sub) {
    return res.status(404).json({ error: 'Subscription not found' })
  }
  res.json(sub)
}

export async function createSubscription(req, res) {
  const {
    name,
    category,
    amount,
    previousAmount,
    billingInterval,
    nextBillingDate,
    status,
    transactionCount,
    confidence,
    lastActivity,
    slug,
    priceChangePct,
    monthlyDifference,
    annualImpact,
    priceIncreaseDate,
    serviceDomain,
    hasDuplicateCharges,
    duplicateAmount,
    duplicateConfidence,
    duplicateAccounts,
    overlappingWith,
    daysSinceLastPayment,
    daysOverdue,
    inactivityReason,
    inactivityEvidence,
  } = req.body

  if (!name || amount === undefined || !nextBillingDate || !category) {
    return res.status(400).json({ error: 'name, category, amount, and nextBillingDate are required' })
  }

  const generatedSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const interval = billingInterval || 'monthly'

  let calculatedPct = priceChangePct
  let calculatedMonthlyDiff = monthlyDifference
  let calculatedAnnualImpact = annualImpact
  let finalStatus = status || 'active'

  if (previousAmount !== undefined && amount > previousAmount) {
    const diff = Math.round((amount - previousAmount) * 100) / 100
    if (calculatedPct === undefined) {
      calculatedPct = Math.round((diff / previousAmount) * 1000) / 10
    }
    if (calculatedMonthlyDiff === undefined) {
      calculatedMonthlyDiff = interval === 'yearly' ? Math.round((diff / 12) * 100) / 100 : diff
    }
    if (calculatedAnnualImpact === undefined) {
      calculatedAnnualImpact = interval === 'yearly' ? diff : Math.round((diff * 12) * 100) / 100
    }
    if (!status || status === 'active') {
      if (calculatedPct >= 5) {
        finalStatus = 'price_increase'
      }
    }
  }

  const sub = await Subscription.create({
    slug: generatedSlug,
    name,
    category,
    amount,
    previousAmount,
    priceChangePct: calculatedPct,
    monthlyDifference: calculatedMonthlyDiff,
    annualImpact: calculatedAnnualImpact,
    priceIncreaseDate,
    serviceDomain,
    hasDuplicateCharges: Boolean(hasDuplicateCharges),
    duplicateAmount: duplicateAmount !== undefined ? duplicateAmount : undefined,
    duplicateConfidence: duplicateConfidence || 'high',
    duplicateAccounts: duplicateAccounts || [],
    overlappingWith: overlappingWith || [],
    daysSinceLastPayment: daysSinceLastPayment !== undefined ? daysSinceLastPayment : undefined,
    daysOverdue: daysOverdue !== undefined ? daysOverdue : undefined,
    inactivityReason,
    inactivityEvidence,
    billingInterval: interval,
    nextBillingDate,
    status: finalStatus,
    transactionCount: transactionCount || 1,
    confidence: confidence !== undefined ? confidence : 0.85,
    lastActivity,
  })

  res.status(201).json(sub)
}

export async function updateSubscription(req, res) {
  const { id } = req.params
  let query = {}
  if (id.match(/^[0-9a-fA-F]{24}$/)) {
    query = { _id: id }
  } else {
    query = { slug: id }
  }

  const existing = await Subscription.findOne(query)
  if (!existing) return res.status(404).json({ error: 'Subscription not found' })

  const update = { ...req.body }
  const effectiveAmount = update.amount !== undefined ? update.amount : existing.amount
  const effectivePrev = update.previousAmount !== undefined ? update.previousAmount : existing.previousAmount
  const effectiveInterval = update.billingInterval || existing.billingInterval || 'monthly'

  if (effectivePrev !== undefined && effectiveAmount > effectivePrev) {
    const diff = Math.round((effectiveAmount - effectivePrev) * 100) / 100
    if (update.priceChangePct === undefined) {
      update.priceChangePct = Math.round((diff / effectivePrev) * 1000) / 10
    }
    if (update.monthlyDifference === undefined) {
      update.monthlyDifference = effectiveInterval === 'yearly' ? Math.round((diff / 12) * 100) / 100 : diff
    }
    if (update.annualImpact === undefined) {
      update.annualImpact = effectiveInterval === 'yearly' ? diff : Math.round((diff * 12) * 100) / 100
    }
    if (!update.status && existing.status === 'active' && update.priceChangePct >= 5) {
      update.status = 'price_increase'
    }
  }

  const sub = await Subscription.findOneAndUpdate(query, update, {
    new: true,
    runValidators: true,
  })

  res.json(sub)
}

export async function deleteSubscription(req, res) {
  const { id } = req.params
  let query = {}
  if (id.match(/^[0-9a-fA-F]{24}$/)) {
    query = { _id: id }
  } else {
    query = { slug: id }
  }

  const sub = await Subscription.findOneAndDelete(query)
  if (!sub) return res.status(404).json({ error: 'Subscription not found' })
  res.status(204).send()
}
