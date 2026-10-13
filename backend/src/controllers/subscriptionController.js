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
  } = req.body

  if (!name || amount === undefined || !nextBillingDate || !category) {
    return res.status(400).json({ error: 'name, category, amount, and nextBillingDate are required' })
  }

  const generatedSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

  const sub = await Subscription.create({
    slug: generatedSlug,
    name,
    category,
    amount,
    previousAmount,
    billingInterval: billingInterval || 'monthly',
    nextBillingDate,
    status: status || 'active',
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

  const sub = await Subscription.findOneAndUpdate(query, req.body, {
    new: true,
    runValidators: true,
  })

  if (!sub) return res.status(404).json({ error: 'Subscription not found' })
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
