import type { AlertSeverity, AlertSubType, AlertType, SavingsBreakdown, SubscriptionStatus } from './types'

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
  notes?: string
  createdAt?: string
  updatedAt?: string
}

export interface ApiAlert {
  _id: string
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
  anomalyReason?: string
  anomalyScore?: number
  expectedAmount?: number
  expectedIntervalDays?: number
  actualIntervalDays?: number
  paymentDate?: string
  detectorVersion?: string
  createdAt?: string
  updatedAt?: string
}

export interface DashboardKpis {
  monthlySpend: number
  monthlySpendChangePct: number | null
  activeSubscriptions: number
  newThisMonth: number | null
  potentialSavings: number
  savingsBreakdown?: SavingsBreakdown
  flaggedCount: number
  alertCount: number
  priceIncreaseAlerts: number
  duplicateAlerts: number
  inactivityAlerts?: number
  anomalyAlerts?: number
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

// ---------------------------------------------------------------------------
// Session authentication (Phase 4.1)
//
// The session itself lives in an HttpOnly cookie that JavaScript cannot read; requests only
// need `credentials: 'include'`. State-changing requests also send the session-bound CSRF
// token, which is kept in memory only (never localStorage) and restored from /auth/me.
// ---------------------------------------------------------------------------

export interface AuthUser {
  id: string
  name: string
  email: string
  createdAt?: string
}

interface AuthResponse {
  user: AuthUser
  csrfToken: string
}

export class ApiError extends Error {
  status: number
  code?: string
  fields?: Record<string, string>

  constructor(message: string, status: number, code?: string, fields?: Record<string, string>) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.fields = fields
  }
}

let csrfToken: string | null = null
let unauthorizedHandler: (() => void) | null = null

export function setCsrfToken(token: string | null) {
  csrfToken = token
}

/** Called when a private request returns 401 (expired/revoked session). */
export function onUnauthorized(handler: (() => void) | null) {
  unauthorizedHandler = handler
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

async function send(path: string, options: RequestInit = {}) {
  const method = (options.method || 'GET').toUpperCase()
  const headers = new Headers(options.headers)
  if (!(options.body instanceof FormData) && options.body !== undefined) {
    headers.set('Content-Type', 'application/json')
  }
  if (!SAFE_METHODS.has(method) && csrfToken) headers.set('X-CSRF-Token', csrfToken)
  return fetch(`${API_URL}${path}`, { ...options, method, headers, credentials: 'include' })
}

async function toApiError(res: Response) {
  const body = await res.json().catch(() => null)
  return new ApiError(body?.error || `Request failed with status ${res.status}`, res.status, body?.code, body?.fields)
}

async function request<T>(path: string, options?: RequestInit, { authEndpoint = false } = {}): Promise<T> {
  let res = await send(path, options)

  // The in-memory CSRF token can be missing or stale (e.g. after a re-login in another tab):
  // refresh it from the session once and retry.
  if (res.status === 403 && !authEndpoint) {
    const err = await toApiError(res.clone())
    if (err.code === 'CSRF_INVALID') {
      const me = await send('/auth/me')
      if (me.ok) {
        setCsrfToken(((await me.json()) as AuthResponse).csrfToken)
        res = await send(path, options)
      }
    }
  }

  if (!res.ok) {
    const err = await toApiError(res)
    if (res.status === 401 && !authEndpoint) unauthorizedHandler?.()
    throw err
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const res = await request<AuthResponse>('/auth/me', undefined, { authEndpoint: true })
    setCsrfToken(res.csrfToken)
    return res.user
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setCsrfToken(null)
      return null
    }
    throw err
  }
}

export async function login(email: string, password: string) {
  const res = await request<AuthResponse>(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ email, password }) },
    { authEndpoint: true },
  )
  setCsrfToken(res.csrfToken)
  return res.user
}

export async function register(name: string, email: string, password: string) {
  const res = await request<AuthResponse>(
    '/auth/register',
    { method: 'POST', body: JSON.stringify({ name, email, password }) },
    { authEndpoint: true },
  )
  setCsrfToken(res.csrfToken)
  return res.user
}

export async function logout() {
  try {
    // Uses the regular path so a stale CSRF token is refreshed and the revocation retried;
    // the server-side session must not survive a logout click.
    await request<void>('/auth/logout', { method: 'POST', body: '{}' })
  } finally {
    setCsrfToken(null)
  }
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
    body: '{}',
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
