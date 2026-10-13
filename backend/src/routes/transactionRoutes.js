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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } })

export const transactionRoutes = Router()

transactionRoutes.get('/', asyncHandler(listTransactions))
transactionRoutes.post('/', asyncHandler(createTransaction))
transactionRoutes.post('/import', upload.single('file'), asyncHandler(importTransactions))
transactionRoutes.post('/analyze', asyncHandler(triggerDetection))
transactionRoutes.get('/:id', asyncHandler(getTransaction))
transactionRoutes.put('/:id', asyncHandler(updateTransaction))
transactionRoutes.delete('/:id', asyncHandler(deleteTransaction))
