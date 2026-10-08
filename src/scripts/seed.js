// npm run db:seed -> demo data: 1 org, 3 users, 1 project, 45 tasks (to try pagination/sorting)
const bcrypt = require('bcryptjs');
const env = require('../config/env');
const { pool, withTransaction } = require('../config/db');

const PASSWORD = 'Password123';

(async () => {
  try {
    const hash = await bcrypt.hash(PASSWORD, env.BCRYPT_ROUNDS);
    await withTransaction(async (run) => {
      const mk = async (name, email) =>
        (await run('INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [name, email, hash])).rows[0].id;

      const owner = await mk('Olivia Owner', 'owner@acme.test');
      const manager = await mk('Mark Manager', 'manager@acme.test');
      const employee = await mk('Emma Employee', 'employee@acme.test');

      const org = (await run('INSERT INTO organizations (name, owner_id) VALUES ($1, $2) RETURNING id', ['Acme Corp', owner])).rows[0].id;
      await run(`INSERT INTO memberships (user_id, org_id, role, reports_to) VALUES ($1, $2, 'OWNER', NULL)`, [owner, org]);
      await run(`INSERT INTO memberships (user_id, org_id, role, reports_to) VALUES ($1, $2, 'MANAGER', $3)`, [manager, org, owner]);
      await run(`INSERT INTO memberships (user_id, org_id, role, reports_to) VALUES ($1, $2, 'EMPLOYEE', $3)`, [employee, org, manager]);

      const project = (
        await run(
          `INSERT INTO projects (org_id, name, project_key, description, manager_id, created_by, task_counter)
           VALUES ($1, 'Website Redesign', 'WEB', 'Redesign the company website', $2, $2, 45) RETURNING id`,
          [org, manager]
        )
      ).rows[0].id;
      await run('INSERT INTO project_members (project_id, user_id) VALUES ($1, $2), ($1, $3)', [project, manager, employee]);

      await run(
        `INSERT INTO tasks (project_id, task_number, title, description, status, priority, assignee_id, reporter_id, due_date)
         SELECT $1::uuid, g,
                'Sample task #' || g,
                'Auto-generated demo task number ' || g,
                (ARRAY['TODO','IN_PROGRESS','IN_REVIEW','DONE'])[1 + (g * 7) % 4]::task_status,
                (ARRAY['LOW','MEDIUM','HIGH','CRITICAL'])[1 + (g * 3) % 4]::task_priority,
                CASE WHEN g % 2 = 0 THEN $2::uuid ELSE $3::uuid END,
                $3::uuid,
                CURRENT_DATE + (g % 20 - 5)
           FROM generate_series(1, 45) AS g`,
        [project, employee, manager]
      );
    });
    console.log('Seed complete. Log in with any of these (password: Password123):');
    console.log('  owner@acme.test | manager@acme.test | employee@acme.test');
  } catch (err) {
    console.error('Seed failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
