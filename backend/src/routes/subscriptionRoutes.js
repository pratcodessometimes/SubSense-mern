import { Router } from 'express'
import {
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  reviewSubscription,
  updateSubscription,
} from '../controllers/subscriptionController.js'
import { asyncHandler } from '../middleware/asyncHandler.js'

export const subscriptionRoutes = Router()

subscriptionRoutes.get('/', asyncHandler(listSubscriptions))
subscriptionRoutes.post('/', asyncHandler(createSubscription))
subscriptionRoutes.get('/:id', asyncHandler(getSubscription))
subscriptionRoutes.put('/:id', asyncHandler(updateSubscription))
subscriptionRoutes.patch('/:id/review', asyncHandler(reviewSubscription))
subscriptionRoutes.delete('/:id', asyncHandler(deleteSubscription))
