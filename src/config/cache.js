const NodeCache = require('node-cache');
const env = require('./env');
const logger = require('./logger');

const store = new NodeCache({ stdTTL: env.CACHE_TTL_SECONDS, checkperiod: 120, useClones: true });

module.exports = {
  get(key) {
    return store.get(key);
  },
  set(key, value, ttlSeconds) {
    return ttlSeconds ? store.set(key, value, ttlSeconds) : store.set(key, value);
  },
  del(...keys) {
    store.del(keys.flat());
  },
  // Remove every key that starts with prefix, e.g. "project:<orgId>:"
  delByPrefix(prefix) {
    const keys = store.keys().filter((k) => k.startsWith(prefix));
    if (keys.length) store.del(keys);
  },
  // Cache-aside helper: return cached value or load it, cache it, return it.
  async wrap(key, ttlSeconds, loader) {
    const hit = store.get(key);
    if (hit !== undefined) {
      logger.debug('cache hit', { key });
      return hit;
    }
    logger.debug('cache miss', { key });
    const value = await loader();
    if (value !== undefined && value !== null) store.set(key, value, ttlSeconds);
    return value;
  },
  stats: () => store.getStats(),
};
