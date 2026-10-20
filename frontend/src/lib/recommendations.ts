import { Activity, Clock, Copy, HelpCircle, Layers, TrendingUp } from 'lucide-react'
import type { RecommendationCategory } from './api'

/** Display label and icon for each recommendation category (Phase 4.3). */
export const CATEGORY_META: Record<RecommendationCategory, { label: string; icon: typeof Copy }> = {
  duplicate_billing: { label: 'Duplicate billing', icon: Copy },
  payment_anomaly: { label: 'Unusual payment', icon: Activity },
  price_increase: { label: 'Price increase', icon: TrendingUp },
  service_overlap: { label: 'Service overlap', icon: Layers },
  inactivity_review: { label: 'Missing payment', icon: Clock },
  unreviewed_subscription: { label: 'Needs your review', icon: HelpCircle },
}
