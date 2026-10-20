import { Router } from 'express'
import { getCategorySpend, getKpis, getMonthlyAnalytics } from '../controllers/analyticsController.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const analyticsRoutes = Router()

analyticsRoutes.get('/kpis', asyncHandler(getKpis))
analyticsRoutes.get('/categories', asyncHandler(getCategorySpend))
analyticsRoutes.get('/monthly', asyncHandler(getMonthlyAnalytics))
