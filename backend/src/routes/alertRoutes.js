import { Router } from 'express'
import { listAlerts } from '../controllers/alertController.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const alertRoutes = Router()

alertRoutes.get('/', asyncHandler(listAlerts))
