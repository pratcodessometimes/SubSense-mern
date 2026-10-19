export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)

  // Malformed or oversized JSON bodies are client errors, not server failures.
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' })
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' })

  console.error(err)

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message })
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ error: `Invalid id: ${err.value}` })
  }

  res.status(500).json({ error: 'Something went wrong on the server' })
}
