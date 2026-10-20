import { loadRecommendations } from '../services/recommendationService.js'

/**
 * GET /api/recommendations — the authenticated user's ranked recommendations.
 * The user and their saved preferences (focus + alert visibility) come only from the session;
 * no userId/focus query parameters are accepted. Read-only: nothing is written or persisted.
 */
export async function listRecommendations(req, res) {
  res.json(await loadRecommendations(req.user.id, req.user.preferences))
}
