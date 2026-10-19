// Resolve 'mongoose' to the in-memory fake and 'dotenv' to a no-op during unit tests.
const redirects = {
  mongoose: './fake-mongoose.mjs',
  dotenv: './noop-dotenv.mjs',
  'dotenv/config': './noop-dotenv.mjs',
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier in redirects) {
    return { url: new URL(redirects[specifier], import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
