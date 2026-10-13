import type { AlertSeverity, AlertType, SubscriptionStatus } from './types'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'

export interface ApiTransaction {
  _id: string
  date: string
  merchant: string
  amount: number
  account: string
  category?: string
  isRecurring: boolean
  subscriptionId?: string
  notes?: string
  createdAt?: string
  updatedAt?: string
}

export interface TransactionInput {
  date: string
  merchant: string
  amount: number
  account?: string
  category?: string
  isRecurring?: boolean
  subscriptionId?: string
  notes?: string
}

export interface ApiSubscription {
  _id: string
  slug?: string
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
  notes?: string
  createdAt?: string
  updatedAt?: string
}

export interface ApiAlert {
  _id: string
  type: AlertType
  severity: AlertSeverity
  title: string
  description: string
  subscriptionIds: string[]
  impact: string
  impactLabel: string
  createdAt?: string
}

export interface DashboardKpis {
  monthlySpend: number
  monthlySpendChangePct: number
  activeSubscriptions: number
  newThisMonth: number
  potentialSavings: number
  flaggedCount: number
  alertCount: number
  priceIncreaseAlerts: number
  duplicateAlerts: number
  transactionCount?: number
}

export interface DetectionResult {
  detectedCount: number
  updatedCount: number
  totalSubscriptions: number
  subscriptions: ApiSubscription[]
  alertsCount: number
}

export interface ImportResult {
  count: number
  skippedCount: number
  totalProcessed: number
  transactions: ApiTransaction[]
  detection?: DetectionResult
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: options?.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...options,
  })

  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `Request failed with status ${res.status}`)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export function listTransactions() {
  return request<ApiTransaction[]>('/transactions')
}

export function createTransaction(input: TransactionInput) {
  return request<ApiTransaction>('/transactions', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateTransaction(id: string, input: TransactionInput) {
  return request<ApiTransaction>(`/transactions/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deleteTransaction(id: string) {
  return request<void>(`/transactions/${id}`, { method: 'DELETE' })
}

export function importTransactionsCsv(file: File) {
  const formData = new FormData()
  formData.append('file', file)
  return request<ImportResult>('/transactions/import', {
    method: 'POST',
    body: formData,
  })
}

export function analyzeTransactions() {
  return request<DetectionResult>('/transactions/analyze', {
    method: 'POST',
  })
}

export function listSubscriptions(category?: string) {
  const query = category && category !== 'All' ? `?category=${encodeURIComponent(category)}` : ''
  return request<ApiSubscription[]>(`/subscriptions${query}`)
}

export function getSubscription(id: string) {
  return request<ApiSubscription>(`/subscriptions/${id}`)
}

export function createSubscription(input: Partial<ApiSubscription>) {
  return request<ApiSubscription>('/subscriptions', {
    method: 'POST',
    body: JSON.stringify(input),
  })
}

export function updateSubscription(id: string, input: Partial<ApiSubscription>) {
  return request<ApiSubscription>(`/subscriptions/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  })
}

export function deleteSubscription(id: string) {
  return request<void>(`/subscriptions/${id}`, { method: 'DELETE' })
}

export function listAlerts() {
  return request<ApiAlert[]>('/alerts')
}

export function getDashboardKpis() {
  return request<DashboardKpis>('/analytics/kpis')
}
