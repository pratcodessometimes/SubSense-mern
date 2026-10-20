import multer from 'multer'

// Multer limit codes that mean "the upload is too big" (413) vs. a malformed upload (400).
const UPLOAD_TOO_LARGE = new Set(['LIMIT_FILE_SIZE', 'LIMIT_FIELD_VALUE', 'LIMIT_PART_COUNT'])

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err)

  // Malformed or oversized JSON bodies are client errors, not server failures.
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body' })
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' })

  // Phase 5.1: CSV upload limits (see routes/transactionRoutes.js) are client errors too.
  if (err instanceof multer.MulterError) {
    if (UPLOAD_TOO_LARGE.has(err.code)) {
      return res.status(413).json({ error: 'Upload is too large', code: 'UPLOAD_TOO_LARGE' })
    }
    return res.status(400).json({ error: 'Invalid upload: send one CSV file in the "file" field', code: 'UPLOAD_INVALID' })
  }

  // Other body-parser client errors (unsupported charset/encoding, aborted request, ...).
  if (err.expose && Number.isInteger(err.status) && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({ error: 'Invalid request body' })
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message })
  }
  if (err.name === 'CastError') {
    // The offending value is not echoed back.
    return res.status(400).json({ error: `Invalid value for ${err.path || 'a field'}` })
  }
  if (err.code === 11000) {
    return res.status(409).json({ error: 'A conflicting record already exists' })
  }

  // Unexpected failure: full details stay in the server log, the client gets a generic message.
  console.error(err)
  res.status(500).json({ error: 'Something went wrong on the server' })
}
