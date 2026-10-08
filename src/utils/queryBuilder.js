// Builds a safe parameterised WHERE clause.
//   const w = new Where().add('t.status = ?', 'DONE').add('(t.title ILIKE ? OR t.description ILIKE ?)', '%x%');
//   w.sql    -> "WHERE t.status = $1 AND (t.title ILIKE $2 OR t.description ILIKE $2)"
//   w.params -> ['DONE', '%x%']
// Every "?" in one clause refers to the SAME value. Values never get concatenated into SQL.
class Where {
  constructor() {
    this.clauses = [];
    this.params = [];
  }
  add(sql, value) {
    this.params.push(value);
    const n = this.params.length;
    this.clauses.push(sql.replace(/\?/g, () => `$${n}`));
    return this;
  }
  addIf(condition, sql, value) {
    return condition ? this.add(sql, value) : this;
  }
  raw(sql) {
    this.clauses.push(sql);
    return this;
  }
  get sql() {
    return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : '';
  }
}

// Escape LIKE wildcards so a search for "100%" does not match everything.
const likePattern = (text) => `%${String(text).replace(/[\\%_]/g, '\\$&')}%`;

module.exports = { Where, likePattern };
