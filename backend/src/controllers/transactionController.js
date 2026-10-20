import { parse } from 'csv-parse/sync'
import { Transaction } from '../models/Transaction.js'
import { runSubscriptionDetection, scheduleSubscriptionDetection } from '../services/detectionService.js'
import { normalizeMerchant } from '../services/merchantNormalizer.js'
import { isObjectIdString, ownedBy } from '../utils/ownership.js'

// Phase 4.1: every query is scoped with ownedBy(req.user.id, ...). Records owned by another
// user (or legacy records without an owner) behave exactly like records that do not exist.

const notFound = (res) => res.status(404).json({ error: 'Transaction not found' })

export async function listTransactions(req, res) {
  const { recurring } = req.query
  const filter = {}
  if (recurring === 'true') filter.isRecurring = true
  if (recurring === 'false') filter.isRecurring = false

  const transactions = await Transaction.find(ownedBy(req.user.id, filter)).sort({ date: -1 })
  res.json(transactions)
}

export async function getTransaction(req, res) {
  if (!isObjectIdString(req.params.id)) return notFound(res)
  const transaction = await Transaction.findOne(ownedBy(req.user.id, { _id: req.params.id }))
  if (!transaction) return notFound(res)
  res.json(transaction)
}

export async function createTransaction(req, res) {
  const { date, merchant, amount, account, category, isRecurring, subscriptionId, notes } = req.body

  if (!date || !merchant || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'date, merchant and amount are required' })
  }

  const parsedDate = new Date(date)
  if (Number.isNaN(parsedDate.getTime())) {
    return res.status(400).json({ error: 'Invalid date provided' })
  }

  const parsedAmount = Number(amount)
  if (Number.isNaN(parsedAmount) || parsedAmount < 0) {
    return res.status(400).json({ error: 'Amount must be a positive number' })
  }

  const normalized = normalizeMerchant(merchant)

  const transaction = await Transaction.create({
    userId: req.user.id, // server-assigned; any userId in the body is ignored
    date: parsedDate,
    merchant: merchant.trim(),
    amount: parsedAmount,
    account: account?.trim() || 'Manual Entry',
    category: category?.trim() || normalized.category,
    isRecurring: Boolean(isRecurring),
    subscriptionId,
    notes,
  })

  // Trigger detection update asynchronously (for this user only) to keep subscriptions in sync
  scheduleSubscriptionDetection(req.user.id, 'manual transaction creation')

  res.status(201).json(transaction)
}

export async function updateTransaction(req, res) {
  const { date, merchant, amount, account, category, isRecurring, subscriptionId, notes } = req.body

  if (!isObjectIdString(req.params.id)) return notFound(res)

  // Explicit allowlist: userId, _id and timestamps can never be changed by the client.
  const updateData = { merchant, amount, account, category, isRecurring, subscriptionId, notes }
  for (const key of Object.keys(updateData)) if (updateData[key] === undefined) delete updateData[key]
  if (date) {
    const parsedDate = new Date(date)
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date provided' })
    }
    updateData.date = parsedDate
  }

  // Atomic owner-scoped update: another user's id matches nothing.
  const transaction = await Transaction.findOneAndUpdate(
    ownedBy(req.user.id, { _id: req.params.id }),
    { $set: updateData },
    { new: true, runValidators: true },
  )

  if (!transaction) return notFound(res)

  scheduleSubscriptionDetection(req.user.id, 'transaction update')

  res.json(transaction)
}

export async function deleteTransaction(req, res) {
  if (!isObjectIdString(req.params.id)) return notFound(res)
  const transaction = await Transaction.findOneAndDelete(ownedBy(req.user.id, { _id: req.params.id }))
  if (!transaction) return notFound(res)

  scheduleSubscriptionDetection(req.user.id, 'transaction delete')

  res.status(204).send()
}

const REQUIRED_CSV_COLUMNS = ['date', 'merchant', 'amount']

/**
 * Imports CSV transactions with validation, deduplication, and automated subscription detection.
 */
export async function importTransactions(req, res) {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name "file")' })

  let rows
  try {
    rows = parse(req.file.buffer, { columns: true, trim: true, skip_empty_lines: true })
  } catch {
    return res.status(400).json({ error: 'Could not parse CSV file. Ensure valid comma-separated values.' })
  }

  if (rows.length === 0) return res.status(400).json({ error: 'CSV file has no rows' })

  const headers = Object.keys(rows[0]).map((h) => h.toLowerCase())
  const missing = REQUIRED_CSV_COLUMNS.filter((c) => !headers.includes(c))
  if (missing.length > 0) {
    return res.status(400).json({ error: `CSV is missing required columns: ${missing.join(', ')}` })
  }

  // 1. Validate and normalize each incoming row
  const parsedDocs = []
  const seenSignaturesInCsv = new Set()

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const normalized = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [key.toLowerCase(), value]),
    )

    const dateVal = new Date(normalized.date)
    if (Number.isNaN(dateVal.getTime())) {
      return res.status(400).json({
        error: `Row ${i + 1} has an invalid date: "${normalized.date}". Expected ISO or YYYY-MM-DD.`,
      })
    }

    const amountVal = Number(normalized.amount)
    if (Number.isNaN(amountVal) || amountVal < 0) {
      return res.status(400).json({
        error: `Row ${i + 1} has an invalid amount: "${normalized.amount}". Amount must be a positive number.`,
      })
    }

    const merchantVal = String(normalized.merchant || '').trim()
    if (!merchantVal) {
      return res.status(400).json({ error: `Row ${i + 1} is missing a merchant name.` })
    }

    const accountVal = String(normalized.account || 'Imported').trim()
    const normMerchant = normalizeMerchant(merchantVal)
    const categoryVal = String(normalized.category || normMerchant.category || 'General').trim()
    const isRecurringVal = ['true', '1', 'yes'].includes(String(normalized.isrecurring).toLowerCase())
    const refVal = String(
      normalized.reference ||
      normalized.ref ||
      normalized.transaction_id ||
      normalized.txnid ||
      normalized.id ||
      '',
    ).trim()

    // Deduplication signature: uses unique reference if present, otherwise date, merchant, amount, and account
    const sig = refVal
      ? `ref:${refVal}|${dateVal.toISOString().slice(0, 10)}|${merchantVal.toLowerCase()}|${amountVal.toFixed(2)}`
      : `${dateVal.toISOString().slice(0, 10)}|${merchantVal.toLowerCase()}|${amountVal.toFixed(2)}|${accountVal.toLowerCase()}`

    if (!seenSignaturesInCsv.has(sig)) {
      seenSignaturesInCsv.add(sig)
      parsedDocs.push({
        userId: req.user.id,
        date: dateVal,
        merchant: merchantVal,
        amount: amountVal,
        account: accountVal,
        category: categoryVal,
        isRecurring: isRecurringVal,
        subscriptionId: normalized.subscriptionid || undefined,
        notes: normalized.notes ? String(normalized.notes).trim() : refVal ? `Ref: ${refVal}` : undefined,
        sig,
      })
    }
  }

  // 2. Deduplicate against THIS user's existing transactions only (Idempotency).
  //    Another user's identical rows must never cause a skip.
  const existingTransactions = await Transaction.find(ownedBy(req.user.id, {
    date: {
      $gte: new Date(Math.min(...parsedDocs.map((d) => d.date.getTime())) - 86400000),
      $lte: new Date(Math.max(...parsedDocs.map((d) => d.date.getTime())) + 86400000),
    },
  }))

  const existingSignatures = new Set(
    existingTransactions.map(
      (t) => `${t.date.toISOString().slice(0, 10)}|${t.merchant.toLowerCase().trim()}|${Number(t.amount).toFixed(2)}|${(t.account || '').toLowerCase().trim()}`,
    ),
  )

  const toInsert = parsedDocs
    .filter((doc) => !existingSignatures.has(doc.sig))
    .map(({ sig, ...cleanDoc }) => cleanDoc)

  const skippedDuplicates = parsedDocs.length - toInsert.length

  let inserted = []
  if (toInsert.length > 0) {
    inserted = await Transaction.insertMany(toInsert)
  }

  // 3. Automatically run the subscription detection engine across this user's transactions
  const detectionResult = await runSubscriptionDetection(req.user.id)

  res.status(201).json({
    count: inserted.length,
    skippedCount: skippedDuplicates,
    totalProcessed: rows.length,
    transactions: inserted,
    detection: {
      detectedCount: detectionResult.detectedCount,
      updatedCount: detectionResult.updatedCount,
      totalSubscriptions: detectionResult.totalSubscriptions,
      subscriptions: detectionResult.subscriptions,
      alertsCount: detectionResult.alertsCount,
      anomalyDetection: detectionResult.anomalyDetection,
    },
  })
}

/**
 * Triggers detection engine manually and returns results.
 */
export async function triggerDetection(req, res) {
  const referenceDate = req.body?.referenceDate || req.query?.referenceDate || null
  if (referenceDate !== null && (typeof referenceDate !== 'string' || Number.isNaN(new Date(referenceDate).getTime()))) {
    return res.status(400).json({ error: 'referenceDate must be a valid date string' })
  }
  const result = await runSubscriptionDetection(req.user.id, referenceDate)
  res.json(result)
}
