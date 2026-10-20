export type SubscriptionStatus =
  | 'active'
  | 'price_increase'
  | 'potentially_inactive'
  | 'needs_review'
  | 'confirmed_cancelled'
  | 'duplicate'
  | 'unused'

/** Phase 4.2: the user's review decision — independent of the detection `status`. */
export type ReviewStatus = 'unreviewed' | 'confirmed' | 'not_subscription'

export interface Subscription {
  id: string
  name: string
  category: string
  amount: number
  previousAmount?: number
  priceChangePct?: number
  monthlyDifference?: number
  annualImpact?: number
  priceIncreaseDate?: string
  billingInterval: 'monthly' | 'yearly'
  nextBillingDate: string
  status: SubscriptionStatus
  transactionCount: number
  confidence: number
  lastActivity?: string
  serviceDomain?: string
  hasDuplicateCharges?: boolean
  duplicateAccounts?: string[]
  duplicateAmount?: number
  duplicateConfidence?: 'high' | 'suspected' | null
  daysSinceLastPayment?: number
  daysOverdue?: number
  inactivityReason?: string
  inactivityEvidence?: string
  overlappingWith?: string[]
  reviewStatus?: ReviewStatus
  reviewedAt?: string | null
}

export interface Transaction {
  id: string
  date: string
  merchant: string
  amount: number
  account: string
  isRecurring: boolean
  subscriptionId?: string
}

export type AlertType =
  | 'price_increase'
  | 'duplicate'
  | 'unused'
  | 'service_overlap'
  | 'inactivity_review'
  | 'payment_anomaly'
export type AlertSubType =
  | 'confirmed_duplicate'
  | 'suspected_duplicate'
  | 'service_overlap'
  | 'potentially_inactive'
  | 'needs_review'
  | 'unusual_amount'
  | 'unusual_timing'
export type AlertSeverity = 'critical' | 'warning' | 'info'

export interface Alert {
  id: string
  type: AlertType
  subType?: AlertSubType
  severity: AlertSeverity
  title: string
  description: string
  subscriptionIds: string[]
  serviceDomain?: string
  duplicateAccounts?: string[]
  impact: string
  impactLabel: string
  previousAmount?: number
  currentAmount?: number
  percentageChange?: number
  monthlyImpact?: number
  annualImpact?: number
  daysSinceLastPayment?: number
  daysOverdue?: number
  expectedBillingDate?: string
  lastPaymentDate?: string
  confidenceLabel?: string
  isManual?: boolean
  // Phase 3.3 payment-anomaly fields (only on type === 'payment_anomaly')
  anomalyReason?: string
  anomalyScore?: number
  expectedAmount?: number
  expectedIntervalDays?: number
  actualIntervalDays?: number
  paymentDate?: string
  detectorVersion?: string
}

export interface MonthlySpend {
  month: string
  amount: number
}

export interface CategorySpend {
  category: string
  amount: number
}

/**
 * Monthly-equivalent INR amounts. Phase 4.3: potentialSavings = duplicateExposure + conditionalSavings;
 * suspected duplicates, inactivity review amounts and price increases are reported separately.
 */
export interface SavingsBreakdown {
  duplicateExposure?: number
  suspectedDuplicateExposure?: number
  conditionalSavings: number
  inactivityReviewAmount?: number
  priceIncreaseImpact: number
  /** Backward-compatible aliases. */
  confirmedSavings: number
  suspectedDuplicateSavings: number
  /** @deprecated Not a saving; use inactivityReviewAmount. */
  inactivitySavings: number
  formula?: string
  explanation: string
}
