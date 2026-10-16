export type SubscriptionStatus = 'active' | 'price_increase' | 'unused' | 'duplicate'

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
  overlappingWith?: string[]
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

export type AlertType = 'price_increase' | 'duplicate' | 'unused' | 'service_overlap'
export type AlertSubType = 'confirmed_duplicate' | 'service_overlap'
export type AlertSeverity = 'critical' | 'warning'

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
  isManual?: boolean
}

export interface MonthlySpend {
  month: string
  amount: number
}

export interface CategorySpend {
  category: string
  amount: number
}
