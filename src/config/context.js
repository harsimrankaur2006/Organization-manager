// Per-request context (trace id) that follows the request through every await.
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

module.exports = {
  als,
  getTraceId: () => (als.getStore() ? als.getStore().traceId : undefined),
};
