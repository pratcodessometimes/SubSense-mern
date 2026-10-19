// Node module-resolution hook: redirect `import mongoose from 'mongoose'` to the stub.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'mongoose') {
    return { url: new URL('./mongoose-stub.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
