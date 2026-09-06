export type SubscriptionStatus = 'active' | 'price_increase' | 'unused' | 'duplicate'

export interface Subscription {
  id: string
  name: string
  category: string
  amount: number
  previousAmount?: number
  billingInterval: 'monthly' | 'yearly'
  nextBillingDate: string
  status: SubscriptionStatus
  transactionCount: number
  confidence: number
  lastActivity?: string
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

export type AlertType = 'price_increase' | 'duplicate' | 'unused'
export type AlertSeverity = 'critical' | 'warning'

export interface Alert {
  id: string
  type: AlertType
  severity: AlertSeverity
  title: string
  description: string
  subscriptionIds: string[]
  impact: string
  impactLabel: string
}

export interface MonthlySpend {
  month: string
  amount: number
}

export interface CategorySpend {
  category: string
  amount: number
}
