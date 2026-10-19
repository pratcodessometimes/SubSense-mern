import { register } from 'node:module'

// Force an obviously fake URI: with the loader below, 'mongoose' is the in-memory
// fake, so this value is never used to open a connection. It also makes the
// legacy DB-backed tests run (they skip themselves when MONGO_URI is unset).
process.env.MONGO_URI = 'memory://subsense-unit-tests'
process.env.SUBSENSE_FAKE_DB = '1'

register('./loader.mjs', import.meta.url)
