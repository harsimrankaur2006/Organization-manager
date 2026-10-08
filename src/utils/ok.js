// Consistent success envelopes.
exports.ok = (res, data, message, status = 200) =>
  res.status(status).json({ success: true, ...(message ? { message } : {}), data });

exports.okPage = (res, { rows, pagination }) =>
  res.status(200).json({ success: true, data: rows, pagination });
