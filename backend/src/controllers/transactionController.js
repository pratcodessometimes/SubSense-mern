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
// Phase 5.1: bounds the work one request can trigger (parsing + a full detection run).
export const MAX_IMPORT_ROWS = 10_000
// Header names that could replace a parsed record's prototype (csv-parse GHSA-8cw4-87c7-c6xx).
const RESERVED_CSV_HEADERS = new Set(['__proto__', 'constructor', 'prototype'])

class CsvHeaderError extends Error {}

/** Normalizes the CSV header row (trimmed, lowercased) and rejects reserved names before any record is built. */
function csvColumns(header) {
  return header.map((raw) => {
    const name = String(raw ?? '').trim().toLowerCase()
    if (RESERVED_CSV_HEADERS.has(name)) throw new CsvHeaderError(`CSV header "${name}" is not allowed`)
    return name
  })
}

const dayKey = (date) => date.toISOString().slice(0, 10)
const norm = (value) => String(value ?? '').toLowerCase().trim()

/**
 * Import identity of a transaction. With a bank reference the reference identifies it; without one
 * only date|merchant|amount|account is available, and two genuinely separate identical purchases
 * share a signature (see the multiset comparison in importTransactions).
 */
function importSignature({ date, merchant, amount, account, reference }) {
  return reference
    ? `ref:${reference}|${dayKey(date)}|${norm(merchant)}|${Number(amount).toFixed(2)}`
    : `${dayKey(date)}|${norm(merchant)}|${Number(amount).toFixed(2)}|${norm(account)}`
}

/** Reference of an already stored row (Phase 5.1 field, or the "Ref: ..." note older imports wrote). */
function storedReference(t) {
  if (t.reference) return t.reference
  const match = /^Ref: (.+)$/.exec(t.notes || '')
  return match ? match[1].trim() : ''
}

/**
 * Imports CSV transactions with validation, deduplication, and automated subscription detection.
 *
 * Phase 5.1 de-duplication (fixes KNOWN ISSUE 2 and reference-id re-imports):
 *  - Rows WITH a reference: one transaction per reference (a repeated reference is the same row).
 *  - Rows WITHOUT a reference: compared as a multiset. If the file has N identical rows and this
 *    user already has M stored, N - M are inserted. Two identical purchases on the same day are
 *    both kept, while re-importing the same file (or an overlapping statement) inserts nothing.
 *    Unavoidable ambiguity: without a bank reference, a later file that contains fewer copies of
 *    an identical row than are already stored cannot add a new copy.
 */
export async function importTransactions(req, res) {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name "file")' })

  let rows
  try {
    rows = parse(req.file.buffer, { columns: csvColumns, trim: true, skip_empty_lines: true })
  } catch (err) {
    if (err instanceof CsvHeaderError) return res.status(400).json({ error: err.message })
    return res.status(400).json({ error: 'Could not parse CSV file. Ensure valid comma-separated values.' })
  }

  if (rows.length === 0) return res.status(400).json({ error: 'CSV file has no rows' })
  if (rows.length > MAX_IMPORT_ROWS) {
    return res.status(413).json({ error: `CSV file has too many rows (maximum ${MAX_IMPORT_ROWS} per import)` })
  }

  const headers = Object.keys(rows[0])
  const missing = REQUIRED_CSV_COLUMNS.filter((c) => !headers.includes(c))
  if (missing.length > 0) {
    return res.status(400).json({ error: `CSV is missing required columns: ${missing.join(', ')}` })
  }

  // 1. Validate and normalize each incoming row, grouping rows by import signature
  const rowsBySignature = new Map()

  for (let i = 0; i < rows.length; i++) {
    const normalized = rows[i]

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
    ).trim().slice(0, 200)

    const doc = {
      userId: req.user.id,
      date: dateVal,
      merchant: merchantVal,
      amount: amountVal,
      account: accountVal,
      category: categoryVal,
      isRecurring: isRecurringVal,
      subscriptionId: normalized.subscriptionid || undefined,
      reference: refVal || undefined,
      notes: normalized.notes ? String(normalized.notes).trim() : refVal ? `Ref: ${refVal}` : undefined,
    }
    const sig = importSignature(doc)
    if (!rowsBySignature.has(sig)) rowsBySignature.set(sig, [])
    // A repeated bank reference is the same transaction listed twice: keep one.
    if (!refVal || rowsBySignature.get(sig).length === 0) rowsBySignature.get(sig).push(doc)
  }

  // 2. Deduplicate against THIS user's existing transactions only (Idempotency).
  //    Another user's identical rows must never cause a skip.
  const parsedTimes = [...rowsBySignature.values()].flat().map((d) => d.date.getTime())
  const existingTransactions = await Transaction.find(ownedBy(req.user.id, {
    date: {
      $gte: new Date(Math.min(...parsedTimes) - 86400000),
      $lte: new Date(Math.max(...parsedTimes) + 86400000),
    },
  }))

  const existingCounts = new Map()
  for (const t of existingTransactions) {
    const sig = importSignature({
      date: new Date(t.date),
      merchant: t.merchant,
      amount: t.amount,
      account: t.account,
      reference: storedReference(t),
    })
    existingCounts.set(sig, (existingCounts.get(sig) || 0) + 1)
  }

  const toInsert = []
  let identicalRowsKept = 0
  for (const [sig, docs] of rowsBySignature) {
    const fresh = docs.slice(existingCounts.get(sig) || 0)
    toInsert.push(...fresh)
    if (docs.length > 1) identicalRowsKept += fresh.length
  }
  const skippedDuplicates = rows.length - toInsert.length

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
    // Rows inserted although an identical row (same date, merchant, amount and account, no
    // reference) is in the same file: kept as separate purchases, worth checking on the statement.
    identicalRowsKept,
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
