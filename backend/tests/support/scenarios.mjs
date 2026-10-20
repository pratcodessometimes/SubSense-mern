// Synthetic transaction scenarios shared by HTTP tests (no real financial data).

export function monthlyDates(year, month, day, n) {
  return Array.from({ length: n }, (_, k) => new Date(Date.UTC(year, month - 1 + k, day)).toISOString().slice(0, 10))
}

export const toCsv = (rows) =>
  ['date,merchant,amount,account', ...rows.map((r) => `${r.date},${r.merchant},${r.amount},${r.account}`)].join('\n')

/**
 * The Phase 3.3 integrated scenario (see anomalyIntegration.test.js), analysed with referenceDate
 * 2025-12-20: Cult.fit one-off overcharge (payment anomaly), Netflix price rise, Spotify duplicate
 * on a second card, Slack late charge, AWS short history and irregular Swiggy noise.
 */
export function anomalyScenarioRows() {
  const rows = []
  const add = (date, merchant, amount, account = 'HDFC 1111') => rows.push({ date, merchant, amount, account })
  monthlyDates(2025, 1, 10, 12).forEach((dt) => add(dt, 'CULT.FIT MEMBERSHIP', dt === '2025-11-10' ? 1100 : 1000))
  monthlyDates(2025, 4, 14, 9).forEach((dt, k) => add(dt, 'POS DEBIT - NETFLIX.COM', k < 6 ? 499 : 649))
  monthlyDates(2025, 6, 8, 7).forEach((dt) => add(dt, 'UPI/SPOTIFY AB/4028', 119))
  add('2025-12-09', 'UPI/SPOTIFY AB/4028', 119, 'ICICI 2222')
  monthlyDates(2025, 1, 3, 11).forEach((dt) => add(dt, 'SLACK TECHNOLOGIES', 700))
  add('2025-12-16', 'SLACK TECHNOLOGIES', 700)
  monthlyDates(2025, 10, 5, 3).forEach((dt) => add(dt, 'AMAZON WEB SERVICES', 820))
  ;[['2025-11-02', 300], ['2025-11-09', 820], ['2025-12-01', 150]].forEach(([dt, a]) => add(dt, 'SWIGGY BANGALORE', a))
  return rows
}

export const ANOMALY_SCENARIO_REFERENCE_DATE = '2025-12-20'
