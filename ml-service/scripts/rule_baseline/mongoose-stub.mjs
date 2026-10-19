// Minimal stand-in for 'mongoose' so the backend's PURE detection functions can
// be imported without node_modules or a database. Any attempt to actually use
// the database fails loudly.
class Schema {
  constructor(definition, options) {
    this.definition = definition
    this.options = options
  }
}

function model(name) {
  const fail = () => {
    throw new Error(`mongoose stub: database access (${name}) is disabled in the ML rule baseline`)
  }
  return new Proxy({ modelName: name }, { get: (t, k) => (k in t ? t[k] : fail) })
}

export default { Schema, model }
