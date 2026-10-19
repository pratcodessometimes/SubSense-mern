// Phase 4.1 — optional legacy-data ownership migration.
//
// Records created before authentication have no userId. They stay invisible to every
// authenticated API. This tool can (optionally, and only when explicitly asked) assign them to
// ONE explicitly selected existing account, roll that assignment back, and manage the
// anomalyKey index change. It NEVER deletes financial records.
//
// DRY RUN (default, read-only):
//   npm run migrate:legacy
//   npm run migrate:legacy -- --target-email owner@example.com
// APPLY (assign all unowned records to one account; prints a batch id for rollback):
//   npm run migrate:legacy -- --apply --target-email owner@example.com --confirm owner@example.com
// ROLLBACK (un-assign exactly the records of one batch):
//   npm run migrate:legacy -- --rollback <batchId> --confirm <batchId>
// INDEX (drop the Phase 3.3 global unique anomalyKey_1 index, then build the per-user index):
//   npm run migrate:legacy -- --drop-legacy-anomaly-index --confirm drop-anomalyKey_1
//
// Take a backup (mongodump / Atlas snapshot) before any non-dry-run command.
// See backend/docs/PHASE_4_1_AUTH_AND_ISOLATION.md.
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import mongoose from 'mongoose'
import { connectDB } from '../config/db.js'
import { Alert } from '../models/Alert.js'
import { Subscription } from '../models/Subscription.js'
import { Transaction } from '../models/Transaction.js'
import { User } from '../models/User.js'

export const LEGACY_ANOMALY_INDEX = 'anomalyKey_1'
// `{ userId: null }` matches documents where userId is missing or null.
const UNOWNED = { userId: null }
const BATCH_FIELD = 'legacyMigrationBatch'

export const COLLECTIONS = { transactions: Transaction, subscriptions: Subscription, alerts: Alert }

/** Read-only inspection of unowned records and anything that would block an assignment. */
export async function inspectLegacyData({ targetEmail } = {}) {
  const counts = {}
  for (const [name, Model] of Object.entries(COLLECTIONS)) counts[name] = await Model.countDocuments(UNOWNED)

  let target = null
  const conflicts = { anomalyKeys: [], subscriptionSlugs: [] }
  if (targetEmail) {
    const user = await User.findOne({ email: String(targetEmail).trim().toLowerCase() })
    if (user) {
      target = { id: String(user._id), email: user.email, name: user.name }
      // Same anomalyKey would violate the per-user unique index after assignment.
      const legacyKeys = (await Alert.find({ ...UNOWNED, anomalyKey: { $type: 'string' } })).map((a) => a.anomalyKey)
      if (legacyKeys.length > 0) {
        const owned = await Alert.find({ userId: user._id, anomalyKey: { $in: legacyKeys } })
        conflicts.anomalyKeys = owned.map((a) => a.anomalyKey)
      }
      // Not an index violation, but would leave two subscriptions with one slug for this user.
      const legacySlugs = (await Subscription.find(UNOWNED)).map((s) => s.slug).filter(Boolean)
      if (legacySlugs.length > 0) {
        const owned = await Subscription.find({ userId: user._id, slug: { $in: legacySlugs } })
        conflicts.subscriptionSlugs = owned.map((s) => s.slug)
      }
    }
  }

  let alertIndexes = null
  if (Alert.collection?.indexes) {
    try {
      alertIndexes = (await Alert.collection.indexes()).map((ix) => ix.name)
    } catch {
      alertIndexes = [] // collection does not exist yet
    }
  }

  return {
    counts,
    totalUnowned: Object.values(counts).reduce((a, b) => a + b, 0),
    targetEmail: targetEmail || null,
    target,
    conflicts,
    alertIndexes,
    legacyAnomalyIndexPresent: alertIndexes ? alertIndexes.includes(LEGACY_ANOMALY_INDEX) : null,
  }
}

/** Assigns every unowned record to the target user. Refuses on any anomalyKey conflict. */
export async function assignLegacyData({ targetEmail, batchId = randomUUID() }) {
  const report = await inspectLegacyData({ targetEmail })
  if (!report.target) throw new Error(`Target user ${targetEmail} does not exist. Register the account first.`)
  if (report.conflicts.anomalyKeys.length > 0) {
    throw new Error(
      `Refusing to assign: ${report.conflicts.anomalyKeys.length} legacy anomaly alert(s) share an anomalyKey with ` +
        'alerts the target already owns. Re-run detection for the target after assignment instead, or resolve manually.',
    )
  }

  const assigned = {}
  for (const [name, Model] of Object.entries(COLLECTIONS)) {
    // strict:false lets the batch marker (not a schema path) be written for rollback.
    const res = await Model.updateMany(
      UNOWNED,
      { $set: { userId: report.target.id, [BATCH_FIELD]: batchId } },
      { strict: false },
    )
    assigned[name] = res.modifiedCount ?? res.nModified ?? 0
  }
  return { batchId, target: report.target, assigned }
}

/** Reverts one assignment batch: those records become unowned (invisible) again. */
export async function rollbackLegacyAssignment({ batchId }) {
  if (!batchId) throw new Error('batchId is required')
  const reverted = {}
  for (const [name, Model] of Object.entries(COLLECTIONS)) {
    const res = await Model.updateMany(
      { [BATCH_FIELD]: batchId },
      { $unset: { userId: 1, [BATCH_FIELD]: 1 } },
      { strict: false },
    )
    reverted[name] = res.modifiedCount ?? res.nModified ?? 0
  }
  return { batchId, reverted }
}

/** Drops the Phase 3.3 global unique anomalyKey index and builds the schema's per-user index. */
export async function migrateAnomalyKeyIndex() {
  const names = (await Alert.collection.indexes()).map((ix) => ix.name)
  const dropped = names.includes(LEGACY_ANOMALY_INDEX)
  if (dropped) await Alert.collection.dropIndex(LEGACY_ANOMALY_INDEX)
  await Alert.createIndexes() // creates missing schema indexes only; never drops anything
  return { dropped, indexes: (await Alert.collection.indexes()).map((ix) => ix.name) }
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const [key, inline] = arg.slice(2).split('=', 2)
    if (inline !== undefined) args[key] = inline
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[key] = argv[++i]
    else args[key] = true
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  await connectDB()
  try {
    if (args.rollback) {
      if (args.confirm !== args.rollback) throw new Error('Rollback requires --confirm <batchId> (same value)')
      console.log(JSON.stringify(await rollbackLegacyAssignment({ batchId: args.rollback }), null, 2))
    } else if (args['drop-legacy-anomaly-index']) {
      if (args.confirm !== `drop-${LEGACY_ANOMALY_INDEX}`) {
        throw new Error(`Index migration requires --confirm drop-${LEGACY_ANOMALY_INDEX}`)
      }
      console.log(JSON.stringify(await migrateAnomalyKeyIndex(), null, 2))
    } else if (args.apply) {
      const email = args['target-email']
      if (!email || typeof email !== 'string') throw new Error('--apply requires --target-email <email>')
      if (args.confirm !== email) throw new Error('--apply requires --confirm <the same email> to proceed')
      const result = await assignLegacyData({ targetEmail: email })
      console.log(JSON.stringify(result, null, 2))
      console.log(`Rollback with: npm run migrate:legacy -- --rollback ${result.batchId} --confirm ${result.batchId}`)
    } else {
      const report = await inspectLegacyData({ targetEmail: args['target-email'] })
      console.log('DRY RUN — no changes made.')
      console.log(JSON.stringify(report, null, 2))
      if (args['target-email'] && !report.target) console.log(`Target user ${args['target-email']} was not found.`)
    }
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Migration failed:', err.message)
    process.exit(1)
  })
}
