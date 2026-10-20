import { Router } from 'express'
import { listRecommendations } from '../controllers/recommendationController.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const recommendationRoutes = Router()

recommendationRoutes.get('/', asyncHandler(listRecommendations))
