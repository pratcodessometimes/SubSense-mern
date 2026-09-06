export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)

  console.error(err)

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message })
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ error: `Invalid id: ${err.value}` })
  }

  res.status(500).json({ error: 'Something went wrong on the server' })
}
