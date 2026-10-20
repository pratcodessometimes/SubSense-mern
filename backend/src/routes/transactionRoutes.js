import { Router } from 'express'
import multer from 'multer'
import {
  createTransaction,
  deleteTransaction,
  getTransaction,
  importTransactions,
  listTransactions,
  triggerDetection,
  updateTransaction,
} from '../controllers/transactionController.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

// Phase 5.1: the CSV is held in memory, so the upload is bounded tightly (2 MB is roughly 20,000
// statement rows; the controller also caps the row count). Limit errors become 413/400 responses
// in middleware/errorHandler.js instead of 500s.
export const MAX_CSV_BYTES = 2 * 1024 * 1024
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CSV_BYTES, files: 1, fields: 10, parts: 12, fieldSize: 10 * 1024 },
})

export const transactionRoutes = Router()

transactionRoutes.get('/', asyncHandler(listTransactions))
transactionRoutes.post('/', asyncHandler(createTransaction))
transactionRoutes.post('/import', upload.single('file'), asyncHandler(importTransactions))
transactionRoutes.post('/analyze', asyncHandler(triggerDetection))
transactionRoutes.get('/:id', asyncHandler(getTransaction))
transactionRoutes.put('/:id', asyncHandler(updateTransaction))
transactionRoutes.delete('/:id', asyncHandler(deleteTransaction))
