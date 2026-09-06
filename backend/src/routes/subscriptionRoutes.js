import { Router } from 'express'
import { getSubscription, listSubscriptions } from '../controllers/subscriptionController.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const subscriptionRoutes = Router()

subscriptionRoutes.get('/', asyncHandler(listSubscriptions))
subscriptionRoutes.get('/:id', asyncHandler(getSubscription))
