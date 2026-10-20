import type { AlertPreferences } from './api'
import type { Alert } from './types'

export type AlertCategory = keyof AlertPreferences

/** Settings labels, in display order. */
export const ALERT_CATEGORIES: Array<{ key: AlertCategory; label: string; description: string }> = [
  { key: 'priceIncrease', label: 'Price increase alerts', description: 'A subscription started charging more' },
  { key: 'duplicate', label: 'Duplicate billing alerts', description: 'The same service charged more than once' },
  { key: 'serviceOverlap', label: 'Service overlap alerts', description: 'Several services covering the same need' },
  { key: 'inactivity', label: 'Inactivity review alerts', description: 'An expected renewal did not show up' },
  { key: 'paymentAnomaly', label: 'Payment anomaly alerts', description: 'An unusual amount or timing for a payment' },
]

/**
 * Maps an alert to its visibility preference. Legacy `unused` alerts belong to inactivity
 * review; overlap alerts stored under the old `duplicate` type with subType `service_overlap`
 * are treated as overlap.
 */
export function alertCategory(alert: Pick<Alert, 'type' | 'subType'>): AlertCategory {
  if (alert.type === 'service_overlap' || alert.subType === 'service_overlap') return 'serviceOverlap'
  switch (alert.type) {
    case 'price_increase':
      return 'priceIncrease'
    case 'duplicate':
      return 'duplicate'
    case 'inactivity_review':
    case 'unused':
      return 'inactivity'
    case 'payment_anomaly':
      return 'paymentAnomaly'
  }
}

/** Display-only filter: hidden alerts still exist and reappear when the category is re-enabled. */
export function isAlertVisible(alert: Pick<Alert, 'type' | 'subType'>, prefs: AlertPreferences | undefined) {
  return prefs ? prefs[alertCategory(alert)] !== false : true
}
