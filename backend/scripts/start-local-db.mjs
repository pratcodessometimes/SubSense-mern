import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MongoMemoryServer } from 'mongodb-memory-server'

const dataDir = join(process.cwd(), '.mongodb-local-data')
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true })
}

console.log('Starting local persistent MongoDB (v8.0.17) on port 27017...')
const mongod = await MongoMemoryServer.create({
  instance: {
    port: 27017,
    dbPath: dataDir,
    storageEngine: 'wiredTiger',
  },
})

const uri = mongod.getUri('subsense')
console.log(`\n========================================`)
console.log(`Local MongoDB is running!`)
console.log(`URI: mongodb://127.0.0.1:27017/subsense`)
console.log(`Data stored at: ${dataDir}`)
console.log(`Press Ctrl + C to stop the database.`)
console.log(`========================================\n`)

const shutdown = async () => {
  console.log('\nStopping local MongoDB...')
  await mongod.stop()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
