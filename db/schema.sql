-- =====================================================================
-- Organization Management Platform - PostgreSQL schema (PostgreSQL 13+)
-- WARNING: this file DROPS and recreates every table. Dev use only.
-- =====================================================================
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid() on PG < 13

BEGIN;

DROP TABLE IF EXISTS audit_logs, refresh_tokens, tasks, project_members,
                     projects, memberships, organizations, users CASCADE;
DROP TYPE  IF EXISTS task_priority, task_status, project_status, member_role;

CREATE TYPE member_role    AS ENUM ('OWNER', 'MANAGER', 'EMPLOYEE');
CREATE TYPE project_status AS ENUM ('ACTIVE', 'ARCHIVED');
-- enum order matters: ORDER BY sorts by declaration order
CREATE TYPE task_status    AS ENUM ('TODO', 'IN_PROGRESS', 'IN_REVIEW', 'DONE');
CREATE TYPE task_priority  AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL,
  password_hash TEXT         NOT NULL,              -- bcrypt
  phone_enc     TEXT,                               -- AES-256-GCM encrypted
  is_active     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_uq ON users (email);

-- -------------------------------------------------------- organizations
CREATE TABLE organizations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       VARCHAR(150) NOT NULL,
  owner_id   UUID         NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organizations_name_uq ON organizations (lower(name));

-- ---------------------------------------------------------- memberships
-- role lives HERE (per organization), not on the user.
CREATE TABLE memberships (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL REFERENCES users(id)         ON DELETE CASCADE,
  org_id     UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role       member_role NOT NULL,
  reports_to UUID                 REFERENCES users(id)         ON DELETE SET NULL,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memberships_org_user_uq UNIQUE (org_id, user_id),
  CONSTRAINT memberships_no_self_report CHECK (reports_to IS DISTINCT FROM user_id)
);
CREATE INDEX memberships_user_idx     ON memberships (user_id);
CREATE INDEX memberships_org_role_idx ON memberships (org_id, role);
-- exactly one OWNER per organization, enforced by the database
CREATE UNIQUE INDEX memberships_one_owner_per_org ON memberships (org_id) WHERE role = 'OWNER';

-- ------------------------------------------------------------- projects
CREATE TABLE projects (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       UUID           NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name         VARCHAR(150)   NOT NULL,
  project_key  VARCHAR(10)    NOT NULL,             -- e.g. WEB  -> tasks WEB-1, WEB-2
  description  TEXT           NOT NULL DEFAULT '',
  status       project_status NOT NULL DEFAULT 'ACTIVE',
  manager_id   UUID           NOT NULL REFERENCES users(id),
  created_by   UUID           NOT NULL REFERENCES users(id),
  task_counter INT            NOT NULL DEFAULT 0,   -- last task number issued
  created_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ    NOT NULL DEFAULT now(),
  CONSTRAINT projects_org_key_uq UNIQUE (org_id, project_key)
);
CREATE INDEX projects_org_status_idx ON projects (org_id, status);
CREATE INDEX projects_manager_idx    ON projects (manager_id);

-- ------------------------------------------------------ project_members
CREATE TABLE project_members (
  project_id UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX project_members_user_idx ON project_members (user_id);

-- ---------------------------------------------------------------- tasks
CREATE TABLE tasks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID          NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_number INT           NOT NULL,
  title       VARCHAR(200)  NOT NULL,
  description TEXT          NOT NULL DEFAULT '',
  status      task_status   NOT NULL DEFAULT 'TODO',
  priority    task_priority NOT NULL DEFAULT 'MEDIUM',
  assignee_id UUID                   REFERENCES users(id) ON DELETE SET NULL,
  reporter_id UUID          NOT NULL REFERENCES users(id),
  due_date    DATE,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT tasks_project_number_uq UNIQUE (project_id, task_number)
);
CREATE INDEX tasks_project_status_idx   ON tasks (project_id, status);
CREATE INDEX tasks_project_priority_idx ON tasks (project_id, priority);
CREATE INDEX tasks_assignee_idx         ON tasks (assignee_id);
CREATE INDEX tasks_open_due_idx         ON tasks (due_date) WHERE status <> 'DONE';

-- ------------------------------------------------------- refresh_tokens
-- Only the SHA-256 hash of a refresh token is stored, never the token.
CREATE TABLE refresh_tokens (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   CHAR(64)     NOT NULL UNIQUE,
  family_id    UUID         NOT NULL,                -- one login session = one family
  revoked      BOOLEAN      NOT NULL DEFAULT FALSE,
  expires_at   TIMESTAMPTZ  NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  user_agent   VARCHAR(255),
  ip           VARCHAR(64)
);
CREATE INDEX refresh_tokens_user_idx   ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);

-- ------------------------------------------------------------ audit_logs
CREATE TABLE audit_logs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id      UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id)         ON DELETE SET NULL,
  action      VARCHAR(60) NOT NULL,
  entity_type VARCHAR(40),
  entity_id   UUID,
  trace_id    VARCHAR(64),                       -- same id as in the log files
  metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_created_idx ON audit_logs (org_id, created_at DESC);
CREATE INDEX audit_logs_trace_idx       ON audit_logs (trace_id);

COMMIT;
