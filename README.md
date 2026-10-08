# Organization Management Platform (Jira-style) - Backend

Node.js + Express + PostgreSQL. Roles: **Owner / Manager / Employee**. Plain HTML frontend included (served from `/public`).

## 1. Setup (5 minutes)

Requirements: Node 18+, PostgreSQL 13+.

```bash
npm install
cp .env.example .env            # Windows: copy .env.example .env
```

Edit `.env`:
- `DATABASE_URL` - your Postgres connection string (create an empty DB first: `createdb orgplatform`)
- `JWT_ACCESS_SECRET` - run `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
- `ENCRYPTION_KEY` - run `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (must be 64 hex chars)

```bash
npm run db:init     # creates all tables (DROPS existing ones!)
npm run db:seed     # optional demo data: 3 users, 1 org, 1 project, 45 tasks
npm run dev         # http://localhost:4000
```

Demo logins (after seed), password `Password123`: `owner@acme.test`, `manager@acme.test`, `employee@acme.test`.

## 2. Project structure

```
org-platform/
├── package.json
├── .env.example
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

Layering: **routes** (HTTP, validation, RBAC) -> **service** (business rules + SQL) -> **PostgreSQL**.

## 3. How each professor requirement is met

| Requirement | Where / how |
|---|---|
| Owner / Manager / Employee | `memberships.role` enum per organization. One OWNER per org is enforced by a partial unique index. `reports_to` models the hierarchy. |
| Logging | `config/logger.js` (winston): console + `logs/combined.log` + `logs/error.log` (JSON). `requestLogger` logs every request with status and duration. Passwords and tokens are never logged. |
| Tracing | `middleware/traceId.js` gives every request a UUID (returned as `X-Trace-Id`), stored in AsyncLocalStorage, so every log line, every audit row (`audit_logs.trace_id`) and every error response carries it. |
| Global exception handling | `middleware/errorHandler.js`. Services throw `AppError`; Postgres errors (duplicate, FK, bad UUID), JWT errors, malformed JSON are translated; unknown errors become a safe 500. Also `unhandledRejection` / `uncaughtException` hooks in `server.js`. |
| Pagination and sorting | Every list endpoint: `?page=1&size=10&sortBy=...&order=asc|desc`. `sortBy` is checked against a whitelist (no SQL injection). Stable ordering via tie-breaker. Response includes `totalItems`, `totalPages`, `hasNext`, `hasPrev`. |
| JWT | Access token (HS256, 15 min, algorithm pinned, has `jti`). |
| RBAC | `requireMember` (is the user in this org?) then `requireRole(...)` (does the role allow it?). Role is read from the DB (cached 60s) so role changes apply immediately. Project/task rules (project manager, assignee) are enforced in services. Everything is scoped by `org_id` so one org can never read another org's data. |
| Encryption | Passwords: bcrypt (12 rounds). Phone number: AES-256-GCM at rest. Refresh tokens: only SHA-256 hash stored. |
| Token management | Short access token + long refresh token. Refresh **rotation** (old one revoked on each refresh), **reuse detection** (replayed token revokes the whole session), **logout** revokes the session and blacklists the access token `jti` until expiry. |
| Caching | `node-cache`: membership/role lookup (hit on every request), org details, project details + task stats, user lookup. Explicit invalidation on every write that affects them. |
| Joins | users-memberships-organizations, tasks-projects-assignee-reporter, audit_logs-users, projects-manager, many-to-many through `project_members`. See `docs/QUERIES.md`. |

## 4. Permission matrix

| Action | Owner | Manager | Employee |
|---|:-:|:-:|:-:|
| Create organization (becomes Owner) | any logged-in user | | |
| Rename organization | yes | | |
| View members / org | yes | yes | yes |
| Add member as MANAGER | yes | | |
| Add member as EMPLOYEE | yes | yes | |
| Change a member's role | yes | | |
| Remove member | any non-owner | employees only | |
| Create project | yes (can pick manager) | yes (self as manager) | |
| See projects | all | own/member | member |
| Edit project, add/remove project members | yes | if project manager | |
| Create / delete tasks | yes | if project manager | |
| Edit any task field | yes | if project manager | |
| Change status of a task | yes | if project manager | only if assigned to them |
| View audit log | yes | | |

## 5. API reference

Base: `/api`. Protected routes need `Authorization: Bearer <accessToken>`.
Success: `{ "success": true, "data": ..., "pagination": {...} }`
Error: `{ "success": false, "error": { "code", "message", "details?", "traceId", "timestamp" } }`

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | DB check + cache stats |
| POST | `/auth/register` | `{name,email,password,phone?}` |
| POST | `/auth/login` | returns `accessToken`, `refreshToken` |
| POST | `/auth/refresh` | `{refreshToken}` -> new pair (rotation) |
| POST | `/auth/logout` | `{refreshToken}`; needs access token |
| GET / PATCH | `/auth/me` | profile + my organizations; PATCH `{name?,phone?}` |
| POST | `/orgs` | `{name}` |
| GET | `/orgs` | my orgs. `search, sortBy=name|joined_at|role` |
| GET / PATCH | `/orgs/:orgId` | details (cached); PATCH `{name}` owner |
| GET | `/orgs/:orgId/members` | `search, role, sortBy=name|email|role|joined_at` |
| POST | `/orgs/:orgId/members` | `{email, role: MANAGER|EMPLOYEE, reportsTo?}` |
| PATCH | `/orgs/:orgId/members/:userId` | `{role?, reportsTo?}` owner |
| DELETE | `/orgs/:orgId/members/:userId` | |
| POST / GET | `/orgs/:orgId/projects` | create `{name, projectKey, description?, managerId?}`; list `search, status, sortBy=name|project_key|created_at|status` |
| GET / PATCH | `/orgs/:orgId/projects/:projectId` | details + `taskStats`; PATCH `{name?,description?,status?,managerId?}` |
| GET / POST | `/orgs/:orgId/projects/:projectId/members` | POST `{userId}` |
| DELETE | `/orgs/:orgId/projects/:projectId/members/:userId` | |
| POST / GET | `/orgs/:orgId/projects/:projectId/tasks` | create `{title, description?, priority?, assigneeId?, dueDate?}`; list `status, priority, assigneeId, search, overdue, sortBy=created_at|updated_at|due_date|priority|status|title` |
| GET | `/orgs/:orgId/tasks/mine` | my tasks across projects |
| GET / PATCH / DELETE | `/orgs/:orgId/tasks/:taskId` | |
| GET | `/orgs/:orgId/audit-logs` | owner. `action, userId, entityType, traceId, sortBy=created_at|action|entity_type` |

### Try it with curl

```bash
# login
curl -s -X POST localhost:4000/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"owner@acme.test","password":"Password123"}'

# export the accessToken from the response, then list orgs
TOKEN=...paste...
curl -s localhost:4000/api/orgs -H "Authorization: Bearer $TOKEN"

# paginated + sorted + filtered tasks (replace ids)
curl -s "localhost:4000/api/orgs/$ORG/projects/$PROJECT/tasks?page=2&size=5&sortBy=priority&order=desc&status=TODO" \
  -H "Authorization: Bearer $TOKEN"
```

## 6. Manual test checklist (good for your demo / viva)

1. Login as employee, `POST /orgs/:org/projects` -> **403**.
2. Employee `PATCH` a task assigned to them with `{"status":"DONE"}` -> OK. With `{"title":"x"}` -> **403**.
3. Use a random UUID as `:orgId` -> **403**; send `abc` as id -> **400** (clean JSON, no stack trace).
4. `?sortBy=password` -> **400** listing allowed columns.
5. Call `/auth/refresh` twice with the same refresh token -> second call **401 TOKEN_REUSE**, and the new token from the first call stops working too.
6. Logout, then reuse the old access token -> **401 TOKEN_REVOKED**.
7. Send malformed JSON -> **400**. Register the same email twice -> **409**.
8. Copy an error's `traceId`, search it in `logs/combined.log` and in `GET /audit-logs?traceId=...`.
9. Set `LOG_LEVEL=debug` and call the same org endpoint twice: second call shows `cache hit`.
10. In `psql`: `SELECT phone_enc FROM users;` shows encrypted text, `SELECT password_hash ...` shows bcrypt.

## 7. Notes and limits (be honest in your report)

- The cache is in-process memory. With several server instances you would switch `config/cache.js` to Redis (same get/set/del API). The logout blacklist has the same limitation; it is acceptable because access tokens live only 15 minutes.
- Roles are fixed to three values. A dynamic permission table would be the next step.
- `db:init` is destructive. Use a migration tool (Prisma Migrate, node-pg-migrate) for real projects.
- Refresh token is returned in JSON for simplicity; in production prefer an `HttpOnly` cookie.
