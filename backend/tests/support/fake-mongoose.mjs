// In-memory stand-in for the small subset of Mongoose that SubSense uses.
//
// TEST-ONLY. It is loaded by tests/support/register.mjs instead of the real
// 'mongoose' package, so unit/integration tests never open a network
// connection and can never write to MongoDB Atlas.
//
// Fidelity goals (only what the app relies on):
//   * Model.create / doc.save() validate `required`, `enum`, `min` and apply
//     defaults and `timestamps`, like Mongoose document validation.
//   * findByIdAndUpdate / findOneAndUpdate validate only with
//     { runValidators: true }, like Mongoose (update validators are opt-in).
//   * `unique` paths reject duplicates with an error whose code is 11000.
//   * Compound `schema.index(fields, { unique, partialFilterExpression })` indexes are
//     enforced too (Phase 4.1: per-user uniqueness such as { userId, anomalyKey }).
//   * Dotted $set paths ("a.b") update nested objects.
//   * Query operators: equality, RegExp, $in, $nin, $ne, $gte, $lte, $gt, $lt, $exists, $type: 'string', $or.

// Ids are 24 hex characters so they look like real ObjectIds to code that validates them.
let idCounter = 0
const nextId = () => (++idCounter).toString(16).padStart(24, '0')

const ObjectId = 'ObjectId'

class Schema {
  constructor(definition = {}, options = {}) {
    this.definition = definition
    this.options = options
    this.compoundIndexes = []
  }
  index(fields, options = {}) {
    this.compoundIndexes.push({ fields, options })
    return this
  }
}
Schema.Types = { ObjectId }

function pathSpec(def) {
  if (Array.isArray(def)) return { isArray: true, item: def[0] }
  if (def && typeof def === 'object' && 'type' in def) return def
  if (typeof def === 'function') return { type: def }
  return {}
}

function isUnique(spec) {
  return spec.unique === true || (spec.index && typeof spec.index === 'object' && spec.index.unique === true)
}

function castValue(spec, value) {
  if (value === undefined || value === null) return value
  if (spec.type === Date) return value instanceof Date ? value : new Date(value)
  if (spec.type === Number) return typeof value === 'number' ? value : Number(value)
  if (spec.type === ObjectId) return String(value)
  if (spec.type === String) {
    const s = spec.trim ? String(value).trim() : String(value)
    return spec.lowercase ? s.toLowerCase() : s
  }
  if (spec.type === Boolean) return Boolean(value)
  return value
}

function validationError(model, path, message) {
  const err = new Error(`${model} validation failed: ${path}: ${message}`)
  err.name = 'ValidationError'
  return err
}

function getField(doc, key) {
  return key.split('.').reduce((v, k) => (v == null ? undefined : v[k]), doc)
}

function matchValue(actual, cond) {
  if (cond instanceof RegExp) {
    return Array.isArray(actual) ? actual.some((a) => cond.test(String(a))) : actual != null && cond.test(String(actual))
  }
  if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, v]) => {
      const vals = Array.isArray(actual) ? actual : [actual]
      switch (op) {
        case '$in': return vals.some((a) => v.some((x) => String(x) === String(a)))
        case '$nin': return !vals.some((a) => v.some((x) => String(x) === String(a)))
        case '$ne': return !vals.some((a) => a === v || (a != null && v != null && String(a) === String(v)))
        case '$gte': return actual != null && actual >= v
        case '$lte': return actual != null && actual <= v
        case '$gt': return actual != null && actual > v
        case '$lt': return actual != null && actual < v
        case '$regex': return matchValue(actual, v instanceof RegExp ? v : new RegExp(v))
        case '$exists': return v ? actual !== undefined : actual === undefined
        case '$type': return v === 'string' ? typeof actual === 'string' : (() => { throw new Error(`fake-mongoose: unsupported $type ${v}`) })()
        default: throw new Error(`fake-mongoose: unsupported operator ${op}`)
      }
    })
  }
  if (Array.isArray(actual)) return actual.some((a) => String(a) === String(cond))
  if (actual instanceof Date && cond instanceof Date) return actual.getTime() === cond.getTime()
  if (actual === undefined || actual === null) return cond === undefined || cond === null
  return String(actual) === String(cond)
}

// Applies a $set object; dotted keys ("a.b.c") write nested paths like MongoDB does.
function withSet(doc, set = {}) {
  const out = structuredClone(doc)
  for (const [key, value] of Object.entries(set)) {
    if (!key.includes('.')) {
      out[key] = value
      continue
    }
    const parts = key.split('.')
    let node = out
    for (const part of parts.slice(0, -1)) {
      if (node[part] === null || typeof node[part] !== 'object') node[part] = {}
      node = node[part]
    }
    node[parts[parts.length - 1]] = value
  }
  return out
}

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, cond]) => {
    if (key === '$or') return cond.some((q) => matches(doc, q))
    if (key === '$and') return cond.every((q) => matches(doc, q))
    return matchValue(getField(doc, key), cond)
  })
}

class Query {
  constructor(exec) {
    this._exec = exec
    this._sort = null
  }
  sort(spec) {
    this._sort = spec
    return this
  }
  lean() {
    return this
  }
  select() {
    return this
  }
  then(resolve, reject) {
    return Promise.resolve()
      .then(() => {
        let res = this._exec()
        if (this._sort && Array.isArray(res)) {
          const [[k, dir]] = Object.entries(this._sort)
          res = [...res].sort((a, b) => {
            const av = a[k] instanceof Date ? a[k].getTime() : a[k]
            const bv = b[k] instanceof Date ? b[k].getTime() : b[k]
            return av < bv ? -dir : av > bv ? dir : 0
          })
        }
        return res
      })
      .then(resolve, reject)
  }
}

const models = new Map()

function model(name, schema) {
  if (models.has(name)) return models.get(name)
  const store = []
  const paths = Object.fromEntries(Object.entries(schema.definition).map(([k, d]) => [k, pathSpec(d)]))
  const timestamps = Boolean(schema.options && schema.options.timestamps)

  function applyDefaultsAndCast(obj) {
    for (const [k, spec] of Object.entries(paths)) {
      if (spec.isArray) {
        if (obj[k] === undefined) obj[k] = []
        else obj[k] = obj[k].map((v) => castValue(pathSpec(spec.item), v))
        continue
      }
      if (obj[k] === undefined && spec.default !== undefined) {
        obj[k] = typeof spec.default === 'function' ? spec.default() : spec.default
      }
      obj[k] = castValue(spec, obj[k])
    }
    return obj
  }

  function validate(obj, { partialKeys = null } = {}) {
    for (const [k, spec] of Object.entries(paths)) {
      if (spec.isArray) continue
      if (partialKeys && !partialKeys.includes(k)) continue
      const v = obj[k]
      if (!partialKeys && spec.required && (v === undefined || v === null || v === '')) {
        throw validationError(name, k, `Path \`${k}\` is required.`)
      }
      if (v === undefined || v === null) continue
      if (spec.enum && !spec.enum.includes(v)) {
        throw validationError(name, k, `\`${v}\` is not a valid enum value for path \`${k}\`.`)
      }
      if (spec.min !== undefined && typeof v === 'number' && v < spec.min) {
        throw validationError(name, k, `Path \`${k}\` (${v}) is less than minimum allowed value (${spec.min}).`)
      }
      if (spec.type === Date && Number.isNaN(v.getTime())) {
        throw validationError(name, k, `Cast to Date failed for value "${v}"`)
      }
    }
  }

  function duplicateKeyError(indexName, detail) {
    const err = new Error(`E11000 duplicate key error collection: ${name} index: ${indexName} dup key: ${detail}`)
    err.code = 11000
    return err
  }

  function checkUnique(obj, selfId) {
    for (const [k, spec] of Object.entries(paths)) {
      if (!isUnique(spec) || obj[k] === undefined || obj[k] === null) continue
      if (store.some((d) => d._id !== selfId && d[k] === obj[k])) {
        throw duplicateKeyError(`${k}_1`, `{ ${k}: "${obj[k]}" }`)
      }
    }
    for (const { fields, options } of schema.compoundIndexes) {
      if (!options.unique) continue
      const partial = options.partialFilterExpression
      if (partial && !matches(obj, partial)) continue
      const keys = Object.keys(fields)
      const same = (d) => keys.every((k) => String(d[k] ?? null) === String(obj[k] ?? null))
      if (store.some((d) => d._id !== selfId && (!partial || matches(d, partial)) && same(d))) {
        throw duplicateKeyError(keys.map((k) => `${k}_1`).join('_'), JSON.stringify(Object.fromEntries(keys.map((k) => [k, obj[k]]))))
      }
    }
  }

  const clone = (raw) => (raw ? hydrate(structuredClone(raw)) : null)

  function hydrate(raw) {
    const doc = new Model(raw, { hydrated: true })
    return doc
  }

  class Model {
    constructor(data = {}, { hydrated = false } = {}) {
      Object.assign(this, hydrated ? data : applyDefaultsAndCast({ ...data }))
      Object.defineProperty(this, '__isNew', { value: !hydrated, writable: true, enumerable: false })
    }

    async save() {
      applyDefaultsAndCast(this)
      validate(this)
      const now = new Date()
      if (this.__isNew) {
        if (!this._id) this._id = nextId()
        checkUnique(this, this._id)
        if (timestamps) {
          this.createdAt = now
          this.updatedAt = now
        }
        store.push(structuredClone({ ...this }))
        this.__isNew = false
      } else {
        checkUnique(this, this._id)
        if (timestamps) this.updatedAt = now
        const i = store.findIndex((d) => d._id === this._id)
        store[i] = structuredClone({ ...this })
      }
      return this
    }

    toObject() {
      return structuredClone({ ...this })
    }

    static async create(data) {
      if (Array.isArray(data)) return Promise.all(data.map((d) => Model.create(d)))
      return new Model(data).save()
    }

    static async insertMany(arr) {
      return Promise.all(arr.map((d) => Model.create(d)))
    }

    static find(query = {}) {
      return new Query(() => store.filter((d) => matches(d, query)).map(clone))
    }

    static findOne(query = {}) {
      return new Query(() => clone(store.find((d) => matches(d, query))))
    }

    static findById(id) {
      return new Query(() => clone(store.find((d) => String(d._id) === String(id))))
    }

    static async countDocuments(query = {}) {
      return store.filter((d) => matches(d, query)).length
    }

    static async deleteMany(query = {}) {
      const before = store.length
      for (let i = store.length - 1; i >= 0; i--) if (matches(store[i], query)) store.splice(i, 1)
      return { deletedCount: before - store.length }
    }

    static async findOneAndDelete(query = {}) {
      const i = store.findIndex((d) => matches(d, query))
      if (i < 0) return null
      const [raw] = store.splice(i, 1)
      return hydrate(raw)
    }

    static async deleteOne(query = {}) {
      const i = store.findIndex((d) => matches(d, query))
      if (i >= 0) store.splice(i, 1)
      return { deletedCount: i >= 0 ? 1 : 0 }
    }

    static async findByIdAndDelete(id) {
      const i = store.findIndex((d) => String(d._id) === String(id))
      if (i < 0) return null
      const [raw] = store.splice(i, 1)
      return hydrate(raw)
    }

    static async updateMany(query, update) {
      let n = 0
      for (const d of store) {
        if (!matches(d, query)) continue
        Object.assign(d, applyDefaultsAndCast(withSet(d, update.$set)))
        for (const k of Object.keys(update.$unset || {})) delete d[k]
        if (timestamps) d.updatedAt = new Date()
        n++
      }
      return { modifiedCount: n }
    }

    static async findByIdAndUpdate(id, update, options = {}) {
      return Model.findOneAndUpdate({ _id: id }, update, options)
    }

    static async findOneAndUpdate(query, update, options = {}) {
      const set = update.$set || (update.$setOnInsert ? {} : update)
      const i = store.findIndex((d) => matches(d, query))
      if (i < 0) {
        if (!options.upsert) return null
        const eqFields = Object.fromEntries(
          Object.entries(query).filter(([k, v]) => !k.startsWith('$') && (typeof v !== 'object' || v === null)),
        )
        const doc = new Model({ ...eqFields, ...(update.$setOnInsert || {}), ...set })
        if (options.runValidators) validate(doc)
        doc._id = doc._id || nextId()
        checkUnique(doc, doc._id)
        const now = new Date()
        if (timestamps) {
          doc.createdAt = now
          doc.updatedAt = now
        }
        store.push(structuredClone({ ...doc }))
        doc.__isNew = false
        return options.new ? clone(store[store.length - 1]) : null
      }
      const before = clone(store[i])
      const next = applyDefaultsAndCast(withSet(store[i], set))
      if (options.runValidators) validate(next, { partialKeys: Object.keys(set) })
      checkUnique(next, store[i]._id)
      if (timestamps) next.updatedAt = new Date()
      store[i] = structuredClone(next)
      return options.new ? clone(store[i]) : before
    }

    // test helpers (not part of Mongoose)
    static __reset() {
      store.length = 0
    }
    static __all() {
      return store.map((d) => structuredClone(d))
    }
  }

  Object.defineProperty(Model, 'name', { value: name })
  Model.modelName = name
  models.set(name, Model)
  return Model
}

const connection = { readyState: 0 }

const mongoose = {
  Schema,
  Types: { ObjectId },
  isValidObjectId: (v) => /^[0-9a-fA-F]{24}$/.test(String(v)),
  set() {},
  model,
  connection,
  async connect() {
    connection.readyState = 1
    return mongoose
  },
  async disconnect() {
    connection.readyState = 0
  },
  __isFake: true,
  __resetAll() {
    for (const m of models.values()) m.__reset()
  },
}

export default mongoose
export { Schema, model, connection }
