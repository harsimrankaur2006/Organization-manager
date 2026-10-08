1. Project structure

```
org-platform/
├── package.json
├── db/
│   └── schema.sql                  all tables, enums, constraints, indexes
├── docs/
│   └── QUERIES.md                  the important SQL, explained
├── public/                         simple frontend (no framework)
│   ├── index.html
│   ├── style.css
│   └── app.js
└── src/
    ├── server.js                   starts server, graceful shutdown, process-level error hooks
    ├── app.js                      middleware order + route mounting
    ├── config/
    │   ├── env.js                  validates .env with zod (fails fast)
    │   ├── db.js                   pg pool, query(), withTransaction()
    │   ├── logger.js               winston (console + logs/*.log), adds traceId automatically
    │   ├── context.js              AsyncLocalStorage that carries the traceId
    │   └── cache.js                node-cache wrapper (get/set/del/wrap)
    ├── middleware/
    │   ├── traceId.js              X-Trace-Id per request
    │   ├── requestLogger.js        request started / finished logs
    │   ├── rateLimit.js            global + stricter auth limiter
    │   ├── validate.js             zod validation for params/query/body
    │   ├── auth.js                 JWT verification (authentication)
    │   ├── rbac.js                 requireMember + requireRole (authorization)
    │   └── errorHandler.js         notFound + GLOBAL exception handler
    ├── utils/
    │   ├── AppError.js             expected errors (400/401/403/404/409)
    │   ├── asyncHandler.js         forwards async errors to the handler
    │   ├── crypto.js               AES-256-GCM encrypt/decrypt, SHA-256, random tokens
    │   ├── jwt.js                  sign / verify access tokens
    │   ├── pagination.js           page + sort whitelist + COUNT/data queries
    │   ├── queryBuilder.js         safe parameterised WHERE builder
    │   ├── schemas.js              shared zod pieces
    │   └── ok.js                   response envelopes
    ├── modules/
    │   ├── auth/            auth.routes.js, auth.service.js
    │   ├── organizations/   orgs.routes.js, orgs.service.js
    │   ├── members/         members.routes.js, members.service.js
    │   ├── projects/        projects.routes.js, projects.service.js
    │   ├── tasks/           tasks.routes.js, tasks.service.js
    │   └── audit/           audit.routes.js, audit.service.js
    └── scripts/
        ├── initDb.js                npm run db:init
        └── seed.js                  npm run db:seed
```

