# Key SQL queries (all parameterised: `$1, $2...`, never string concatenation)

## 1. Pagination + sorting + filtering (`utils/pagination.js`, `utils/queryBuilder.js`)
Two queries run in parallel with the same WHERE:
```sql
SELECT COUNT(*)::int AS total
  FROM tasks t JOIN projects p ON p.id = t.project_id LEFT JOIN users a ON a.id = t.assignee_id JOIN users r ON r.id = t.reporter_id
 WHERE t.project_id = $1 AND t.status = $2;

SELECT t.id, p.project_key || '-' || t.task_number AS task_key, t.title, t.status, t.priority, ...
  FROM tasks t JOIN projects p ... LEFT JOIN users a ... JOIN users r ...
 WHERE t.project_id = $1 AND t.status = $2
 ORDER BY t.priority DESC NULLS LAST, t.id        -- column from a WHITELIST, + tie-breaker
 LIMIT $3 OFFSET $4;                              -- size, (page-1)*size
```
`ORDER BY priority` sorts by enum declaration order (LOW < MEDIUM < HIGH < CRITICAL).

## 2. Joins
```sql
-- my organizations with role + member count (join + correlated subquery)
SELECT o.id, o.name, m.role, m.joined_at,
       (SELECT COUNT(*) FROM memberships mm WHERE mm.org_id = o.id)::int AS member_count
  FROM memberships m JOIN organizations o ON o.id = m.org_id
 WHERE m.user_id = $1;

-- members with who they report to (self-join on users)
SELECT u.id, u.name, u.email, m.role, r.name AS reports_to_name
  FROM memberships m
  JOIN users u      ON u.id = m.user_id
  LEFT JOIN users r ON r.id = m.reports_to
 WHERE m.org_id = $1;

-- project members (many-to-many through project_members, plus org role)
SELECT u.id, u.name, m.role, pm.added_at
  FROM project_members pm
  JOIN users u       ON u.id = pm.user_id
  JOIN memberships m ON m.user_id = u.id AND m.org_id = $2
 WHERE pm.project_id = $1;

-- audit log with the acting user
SELECT a.action, a.trace_id, u.name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = $1;
```

## 3. Aggregation (project dashboard, cached)
```sql
SELECT status, COUNT(*)::int AS count FROM tasks WHERE project_id = $1 GROUP BY status;
```

## 4. Visibility rule for projects (RBAC at row level)
```sql
-- non-owners only see projects they manage or belong to
WHERE p.org_id = $1
  AND (p.manager_id = $2 OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $2))
```
Every project/task query also filters by `org_id`, so guessing an id from another organization returns 404.

## 5. Transactions
```sql
-- create organization: both statements succeed or neither does
BEGIN;
INSERT INTO organizations (name, owner_id) VALUES ($1, $2) RETURNING id;
INSERT INTO memberships (user_id, org_id, role) VALUES ($2, <new id>, 'OWNER');
COMMIT;
```

## 6. Race-free task numbers (WEB-1, WEB-2 ...)
```sql
BEGIN;
UPDATE projects SET task_counter = task_counter + 1 WHERE id = $1 RETURNING task_counter;  -- row lock
INSERT INTO tasks (project_id, task_number, ...) VALUES ($1, <counter>, ...);
COMMIT;
```
Two concurrent requests queue on the row lock, so they never get the same number (also guarded by `UNIQUE (project_id, task_number)`).

## 7. Refresh token rotation
```sql
BEGIN;
SELECT ... FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.token_hash = $1 FOR UPDATE OF rt;
-- already revoked?  => UPDATE refresh_tokens SET revoked = TRUE WHERE family_id = $1;  (reuse detected)
UPDATE refresh_tokens SET revoked = TRUE, last_used_at = now() WHERE id = $1;
INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at, ...) VALUES (...);
COMMIT;
```
`FOR UPDATE` stops two parallel refreshes from both succeeding.

## 8. Rules enforced by the database itself
```sql
CREATE UNIQUE INDEX memberships_one_owner_per_org ON memberships (org_id) WHERE role = 'OWNER';  -- partial unique index
UNIQUE (org_id, user_id)            -- no duplicate membership
UNIQUE (org_id, project_key)        -- project key unique per org
CHECK (email = lower(email))        -- case-insensitive unique emails
CHECK (reports_to IS DISTINCT FROM user_id)
```

## 9. Indexes and why
| Index | Serves |
|---|---|
| `memberships (org_id, user_id)` (unique) | RBAC lookup on every request |
| `memberships (user_id)` | "my organizations" |
| `tasks (project_id, status)` / `(project_id, priority)` | filter + sort inside a project |
| `tasks (assignee_id)` | "my tasks" |
| `tasks (due_date) WHERE status <> 'DONE'` | overdue queries (small partial index) |
| `audit_logs (org_id, created_at DESC)` | latest audit entries |
| `refresh_tokens (token_hash)` unique | refresh lookup |

Check a plan yourself: `EXPLAIN ANALYZE SELECT ... ;` in psql after `npm run db:seed`.
