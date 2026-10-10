// In-memory stand-in for the subset of the Supabase query builder used by the
// publication code. Unsupported filters throw instead of being silently ignored,
// so a test can never pass because a filter was skipped.
import { randomUUID } from "node:crypto";

function matches(row, filters) {
  return filters.every((f) => f(row));
}

function cmp(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return a < b ? -1 : 1;
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.orders = [];
    this.limitN = null;
    this.op = "select";
    this.payload = null;
    this.returning = false;
  }
  rows() { return this.db.table(this.table); }
  select() { if (this.op !== "select") this.returning = true; return this; }
  insert(payload) { this.op = "insert"; this.payload = payload; return this; }
  update(payload) { this.op = "update"; this.payload = payload; return this; }
  upsert(payload) { this.op = "upsert"; this.payload = payload; return this; }
  delete() { this.op = "delete"; return this; }
  eq(col, val) { this.filters.push((r) => r[col] === val || (r[col] !== null && r[col] !== undefined && String(r[col]) === String(val) && typeof val !== "boolean")); return this; }
  neq(col, val) { this.filters.push((r) => r[col] !== val); return this; }
  gt(col, val) { this.filters.push((r) => r[col] !== null && r[col] !== undefined && Number(r[col]) > Number(val)); return this; }
  lt(col, val) { this.filters.push((r) => r[col] !== null && r[col] !== undefined && r[col] < val); return this; }
  in(col, vals) { const set = new Set(vals.map(String)); this.filters.push((r) => set.has(String(r[col]))); return this; }
  not(col, op, val) {
    if (op !== "is" || val !== null) throw new Error(`memory-supabase: unsupported not(${col}, ${op}, ${val})`);
    this.filters.push((r) => r[col] !== null && r[col] !== undefined);
    return this;
  }
  filter(col, op, val) {
    if (op !== "cs") throw new Error(`memory-supabase: unsupported filter op ${op}`);
    const needle = JSON.parse(val);
    this.filters.push((r) => Array.isArray(r[col]) && needle.every((n) => r[col].includes(n)));
    return this;
  }
  or() { throw new Error("memory-supabase: or() is not supported; add explicit support before relying on it"); }
  order(col, opts = {}) { this.orders.push({ col, asc: opts.ascending !== false }); return this; }
  limit(n) { this.limitN = n; return this; }
  maybeSingle() { this.single_ = "maybe"; return this; }
  single() { this.single_ = "one"; return this; }
  then(resolve, reject) { try { resolve(this.execute()); } catch (error) { reject(error); } }

  execute() {
    const failure = this.db.takeFailure(this.table, this.op);
    if (failure) return { data: null, error: { message: failure } };
    let result;
    if (this.op === "insert" || this.op === "upsert") {
      const items = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((p) => ({ id: p.id ?? randomUUID(), ...structuredClone(p) }));
      for (const item of items) {
        const existing = this.rows().findIndex((r) => r.id === item.id);
        if (existing >= 0) this.rows()[existing] = { ...this.rows()[existing], ...item };
        else this.rows().push(item);
      }
      this.db.log.push({ table: this.table, op: this.op, rows: items.map((i) => structuredClone(i)) });
      result = items;
    } else if (this.op === "update") {
      const hits = this.rows().filter((r) => matches(r, this.filters));
      for (const r of hits) Object.assign(r, structuredClone(this.payload));
      this.db.log.push({ table: this.table, op: "update", rows: hits.map((h) => structuredClone(h)), payload: structuredClone(this.payload) });
      result = hits;
    } else if (this.op === "delete") {
      const keep = this.rows().filter((r) => !matches(r, this.filters));
      result = this.rows().filter((r) => matches(r, this.filters));
      this.db.tables.set(this.table, keep);
    } else {
      result = this.rows().filter((r) => matches(r, this.filters));
    }
    result = [...result];
    for (const { col, asc } of [...this.orders].reverse()) result.sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]));
    if (this.limitN !== null) result = result.slice(0, this.limitN);
    const data = structuredClone(result);
    if (this.single_ === "maybe") {
      if (data.length > 1) return { data: null, error: { message: "memory-supabase: multiple rows for maybeSingle" } };
      return { data: data[0] ?? null, error: null };
    }
    if (this.single_ === "one") {
      if (data.length !== 1) return { data: null, error: { message: `memory-supabase: expected 1 row, got ${data.length}` } };
      return { data: data[0], error: null };
    }
    if (this.op !== "select" && !this.returning) return { data: null, error: null };
    return { data, error: null };
  }
}

export function createMemorySupabase(seed = {}) {
  const db = {
    tables: new Map(Object.entries(seed).map(([k, v]) => [k, structuredClone(v)])),
    failures: [],
    log: [],
    table(name) { if (!this.tables.has(name)) this.tables.set(name, []); return this.tables.get(name); },
    takeFailure(table, op) {
      const i = this.failures.findIndex((f) => f.table === table && f.op === op);
      if (i < 0) return null;
      return this.failures.splice(i, 1)[0].message;
    },
    failNext(table, op, message) { this.failures.push({ table, op, message }); },
    from(table) { return new Query(db, table); },
    rpc() { throw new Error("memory-supabase: rpc is not supported"); },
  };
  return db;
}
