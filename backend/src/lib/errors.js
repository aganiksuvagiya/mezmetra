export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Please sign in again') => new HttpError(401, 'UNAUTHORIZED', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (code, message) => new HttpError(409, code, message);
export const forbidden = (message = 'You are not allowed to do this') => new HttpError(403, 'FORBIDDEN', message);
export const suspended = (reason) =>
  new HttpError(
    403,
    'ACCOUNT_SUSPENDED',
    reason ? `Your account has been suspended: ${reason}` : 'Your account has been suspended. Please contact MezMitra support.',
  );

/** Validate `data` with a zod schema and return the parsed value, or throw a 400 with field details. */
export function parse(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    field: issue.path.join('.') || '(body)',
    message: issue.message,
  }));
  const first = details[0];
  throw new HttpError(400, 'VALIDATION_ERROR', `${first.field}: ${first.message}`, details);
}

export function errorHandler(err, req, res, _next) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }
  // Malformed JSON body etc. from express.json()
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Request body is too large' } });
  }
  // PostgreSQL error codes
  if (err?.code === '23505') {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with the same value already exists' } });
  }
  if (err?.code === '23503') {
    return res.status(409).json({ error: { code: 'IN_USE', message: 'This record is still referenced by other data' } });
  }
  if (err?.code === '22P02' || err?.code === '22003') {
    return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid value in request' } });
  }
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side' } });
}
