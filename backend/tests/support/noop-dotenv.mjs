// Unit tests must not read backend/.env (which may hold a real Atlas URI).
export function config() {
  return { parsed: {} }
}
export default { config }
