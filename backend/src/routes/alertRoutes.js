import { Router } from 'express'
import { createAlert, deleteAlert, listAlerts } from '../controllers/alertController.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const alertRoutes = Router()

alertRoutes.get('/', asyncHandler(listAlerts))
alertRoutes.post('/', asyncHandler(createAlert))
alertRoutes.delete('/:id', asyncHandler(deleteAlert))
