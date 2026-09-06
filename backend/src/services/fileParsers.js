import { parse } from 'csv-parse/sync'
import mammoth from 'mammoth'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

function parseFlexibleDate(dateStr) {
  const parts = dateStr.split(/[/\-.]/)
  if (parts.length !== 3) return null

  let [d, m, y] = parts.map((p) => Number(p))
  if (y < 100) y += 2000
  const date = new Date(Date.UTC(y, m - 1, d))
  return Number.isNaN(date.getTime()) ? null : date
}

function parseStatementLine(line) {
  const dateMatch = line.match(/\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}/)
  if (!dateMatch) return null

  const amountMatches = [...line.matchAll(/-?\d[\d,]*\.\d{2}/g)]
  if (amountMatches.length === 0) return null

  const amountStr = amountMatches[amountMatches.length - 1][0]
  const amount = Math.abs(Number(amountStr.replace(/,/g, '')))
  if (Number.isNaN(amount) || amount <= 0) return null

  const date = parseFlexibleDate(dateMatch[0])
  if (!date) return null

  const rawMerchant = line
    .replace(dateMatch[0], ' ')
    .replace(amountStr, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (!rawMerchant) return null

  return { date, rawMerchant, amount, type: 'expense' }
}

export function parseStatementText(text) {
  return text
    .split(/\r?\n/)
    .map(parseStatementLine)
    .filter((record) => record !== null)
}

export function parseCsvBuffer(buffer) {
  const rows = parse(buffer, { columns: true, trim: true, skip_empty_lines: true })
  if (rows.length === 0) return []

  const normalizedRows = rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key.toLowerCase(), value])),
  )

  const headers = Object.keys(normalizedRows[0])
  const missing = ['date', 'merchant', 'amount'].filter((c) => !headers.includes(c))
  if (missing.length > 0) {
    throw new Error(`CSV is missing required columns: ${missing.join(', ')}`)
  }

  return normalizedRows.map((row) => ({
    date: new Date(row.date),
    rawMerchant: row.merchant,
    amount: Number(row.amount),
    type: row.type || 'expense',
    account: row.account,
  }))
}

export async function parsePdfBuffer(buffer) {
  const { text } = await pdfParse(buffer)
  return parseStatementText(text)
}

export async function parseDocxBuffer(buffer) {
  const { value: text } = await mammoth.extractRawText({ buffer })
  return parseStatementText(text)
}
