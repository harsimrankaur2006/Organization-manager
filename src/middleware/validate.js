const AppError = require('../utils/AppError');

// validate({ params, query, body }) - each is a zod schema.
// On success the parsed (coerced, trimmed, defaulted, unknown-keys-stripped) values replace the raw ones.
module.exports = (schemas) => (req, res, next) => {
  const errors = [];
  for (const part of ['params', 'query', 'body']) {
    if (!schemas[part]) continue;
    const result = schemas[part].safeParse(req[part]);
    if (!result.success) {
      result.error.issues.forEach((i) => errors.push({ in: part, field: i.path.join('.'), message: i.message }));
    } else if (part !== 'params') {
      req[part] = result.data;
    }
  }
  if (errors.length) return next(AppError.badRequest('Validation failed', errors));
  next();
};
