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
