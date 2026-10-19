// Runs the UNMODIFIED backend rule engine (analyzeMerchantRecurrence) on
// snapshots prepared by Python, reading/writing JSON files. No database access.
//
//   node --import ./scripts/rule_baseline/register.mjs scripts/rule_baseline/run.mjs in.json out.json
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const servicePath = process.env.SUBSENSE_DETECTION_SERVICE ||
  join(here, '..', '..', '..', 'backend', 'src', 'services', 'detectionService.js')
const { analyzeMerchantRecurrence } = await import(pathToFileURL(resolve(servicePath)).href)

const [, , inPath, outPath] = process.argv
const snapshots = JSON.parse(readFileSync(inPath, 'utf8'))

const results = snapshots.map((s) => {
  const txs = s.txs.map((t) => ({ date: new Date(t.date), amount: t.amount, account: t.account }))
  const r = analyzeMerchantRecurrence(txs, s.merchantName, 'General', s.referenceDate)
  return {
    key: s.key,
    recurring: Boolean(r),
    billingInterval: r ? r.billingInterval : null,
    confidence: r ? r.confidence : null,
    status: r ? r.status : null,
  }
})

writeFileSync(outPath, JSON.stringify({ servicePath: 'backend/src/services/detectionService.js', results }))
console.log(`rule baseline: ${results.length} snapshots, ${results.filter((r) => r.recurring).length} recurring`)
