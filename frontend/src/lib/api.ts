const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000/api'

export interface ApiTransaction {
  _id: string
  date: string
  merchant: string
  amount: number
  account: string
  isRecurring: boolean
  notes?: string
  createdAt: string
  updatedAt: string
}

export interface TransactionInput {
  date: string
  merchant: string
  amount: number
  account?: string
  isRecurring?: boolean
  notes?: string
}

export type SubscriptionStatus = 'active' | 'price_increase' | 'unused' | 'duplicate'

export interface SubscriptionAnomaly {
  type: 'price_increase' | 'trial_conversion' | 'cadence_drift' | 'unused'
  pctChange?: number
  expectedDays?: number
  actualDays?: number
}

export interface ApiSubscription {
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
  lastActivity: string
  history: { date: string; amount: number }[]
  anomalies: SubscriptionAnomaly[]
}

export type AlertType = 'price_increase' | 'trial_conversion' | 'cadence_drift' | 'duplicate' | 'unused'
export type AlertSeverity = 'critical' | 'warning'

export interface ApiAlert {
  id: string
  type: AlertType
  severity: AlertSeverity
  title: string
  description: string
  subscriptionIds: string[]
  impact: string
  impactLabel: string
}

export interface UploadResult {
  imported: number
  transactions: ApiTransaction[]
  subscriptions: ApiSubscription[]
  alerts: ApiAlert[]
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
  return request<{ count: number; transactions: ApiTransaction[] }>('/transactions/import', {
    method: 'POST',
    body: formData,
  })
}

export function uploadTransactionsFile(file: File) {
  const formData = new FormData()
  formData.append('file', file)
  return request<UploadResult>('/transactions/upload', {
    method: 'POST',
    body: formData,
  })
}

export function listSubscriptions() {
  return request<ApiSubscription[]>('/subscriptions')
}

export function getSubscription(id: string) {
  return request<ApiSubscription>(`/subscriptions/${id}`)
}

export function listAlerts() {
  return request<ApiAlert[]>('/alerts')
}
