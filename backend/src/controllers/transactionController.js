import { parse } from 'csv-parse/sync'
import { Transaction } from '../models/Transaction.js'
import { runDetection } from '../services/detectionEngine.js'
import { parseCsvBuffer, parseDocxBuffer, parsePdfBuffer } from '../services/fileParsers.js'

export async function listTransactions(req, res) {
  const { recurring } = req.query
  const filter = {}
  if (recurring === 'true') filter.isRecurring = true
  if (recurring === 'false') filter.isRecurring = false

  const transactions = await Transaction.find(filter).sort({ date: -1 })
  res.json(transactions)
}

export async function getTransaction(req, res) {
  const transaction = await Transaction.findById(req.params.id)
  if (!transaction) return res.status(404).json({ error: 'Transaction not found' })
  res.json(transaction)
}

export async function createTransaction(req, res) {
  const { date, merchant, amount, account, isRecurring, notes } = req.body

  if (!date || !merchant || amount === undefined || amount === null) {
    return res.status(400).json({ error: 'date, merchant and amount are required' })
  }

  const transaction = await Transaction.create({
    date,
    merchant,
    amount,
    account,
    isRecurring: Boolean(isRecurring),
    notes,
  })
  res.status(201).json(transaction)
}

export async function updateTransaction(req, res) {
  const { date, merchant, amount, account, isRecurring, notes } = req.body

  const transaction = await Transaction.findByIdAndUpdate(
    req.params.id,
    { date, merchant, amount, account, isRecurring, notes },
    { new: true, runValidators: true, omitUndefined: true },
  )

  if (!transaction) return res.status(404).json({ error: 'Transaction not found' })
  res.json(transaction)
}

export async function deleteTransaction(req, res) {
  const transaction = await Transaction.findByIdAndDelete(req.params.id)
  if (!transaction) return res.status(404).json({ error: 'Transaction not found' })
  res.status(204).send()
}

const REQUIRED_CSV_COLUMNS = ['date', 'merchant', 'amount']

export async function importTransactions(req, res) {
  if (!req.file) return res.status(400).json({ error: 'CSV file is required (field name "file")' })

  let rows
  try {
    rows = parse(req.file.buffer, { columns: true, trim: true, skip_empty_lines: true })
  } catch {
    return res.status(400).json({ error: 'Could not parse CSV file' })
  }

  if (rows.length === 0) return res.status(400).json({ error: 'CSV file has no rows' })

  const headers = Object.keys(rows[0]).map((h) => h.toLowerCase())
  const missing = REQUIRED_CSV_COLUMNS.filter((c) => !headers.includes(c))
  if (missing.length > 0) {
    return res.status(400).json({ error: `CSV is missing required columns: ${missing.join(', ')}` })
  }

  const docs = rows.map((row) => {
    const normalized = Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key.toLowerCase(), value]),
    )
    return {
      date: new Date(normalized.date),
      merchant: normalized.merchant,
      amount: Number(normalized.amount),
      account: normalized.account || 'Imported',
      isRecurring: ['true', '1', 'yes'].includes(String(normalized.isrecurring).toLowerCase()),
    }
  })

  const invalid = docs.some((d) => Number.isNaN(d.amount) || Number.isNaN(d.date.getTime()))
  if (invalid) return res.status(400).json({ error: 'CSV contains rows with invalid date or amount' })

  const inserted = await Transaction.insertMany(docs)
  res.status(201).json({ count: inserted.length, transactions: inserted })
}

export async function uploadTransactions(req, res) {
  if (!req.file) return res.status(400).json({ error: 'A file is required (field name "file")' })

  const extension = req.file.originalname.split('.').pop()?.toLowerCase()

  let records
  try {
    if (extension === 'csv') {
      records = parseCsvBuffer(req.file.buffer)
    } else if (extension === 'pdf') {
      records = await parsePdfBuffer(req.file.buffer)
    } else if (extension === 'docx') {
      records = await parseDocxBuffer(req.file.buffer)
    } else {
      return res
        .status(400)
        .json({ error: `Unsupported file format ".${extension}". Please upload a CSV, PDF, or DOCX file.` })
    }
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not parse this file' })
  }

  if (records.length === 0) {
    return res.status(400).json({ error: 'No transactions could be found in this file' })
  }

  const invalid = records.some(
    (r) => Number.isNaN(r.amount) || !r.date || Number.isNaN(new Date(r.date).getTime()),
  )
  if (invalid) return res.status(400).json({ error: 'File contains rows with an invalid date or amount' })

  const docs = records.map((r) => ({
    date: r.date,
    merchant: r.rawMerchant,
    amount: r.amount,
    account: r.account || 'Imported',
    type: r.type || 'expense',
    isRecurring: false,
  }))

  const inserted = await Transaction.insertMany(docs)

  const allTransactions = await Transaction.find()
  const { subscriptions, alerts } = runDetection(allTransactions)

  res.status(201).json({ imported: inserted.length, transactions: inserted, subscriptions, alerts })
}
