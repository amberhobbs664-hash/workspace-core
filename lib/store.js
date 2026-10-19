// Postgres-backed store. Uses DATABASE_URL (Roar AI dedicated Postgres).
// Falls back to in-memory pg-mem when DATABASE_URL is missing (tests).
"use strict";

let pool = null;

function getPool() {
  if (pool) return pool;
  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  } else if (process.env.ALLOW_MEMORY_STORE === "true") {
    // local tests only — data does NOT survive restarts
    const { newDb } = require("pg-mem");
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    pool = new Pool();
  } else {
    throw new Error("DATABASE_URL is not set. Attach the Postgres database in the Roar console and add DATABASE_URL to Environment.");
  }
  return pool;
}

const uid = (p) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function init() {
  const p = getPool();
  await p.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await p.query(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await p.query(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, capabilities JSONB NOT NULL DEFAULT '[]',
    key_prefix TEXT, api_key_hash TEXT UNIQUE, token_limit INTEGER,
    status TEXT NOT NULL DEFAULT 'active', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT)`);
  await p.query(`CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL, subtasks JSONB NOT NULL DEFAULT '[]',
    created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await p.query(`CREATE TABLE IF NOT EXISTS usage (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, model TEXT,
    prompt_tokens INT NOT NULL DEFAULT 0, completion_tokens INT NOT NULL DEFAULT 0,
    total_tokens INT NOT NULL DEFAULT 0, at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  await p.query(`CREATE INDEX IF NOT EXISTS usage_agent_at ON usage(agent_id, at)`);
}

// ---- users ----
async function countUsers() {
  const r = await getPool().query("SELECT COUNT(*)::int AS c FROM users");
  return r.rows[0].c;
}
async function createUser(u) {
  await getPool().query(
    "INSERT INTO users(id,name,email,pass_hash,role) VALUES($1,$2,$3,$4,$5)",
    [u.id, u.name, u.email, u.pass_hash, u.role]);
}
async function findUserByEmail(email) {
  const r = await getPool().query("SELECT * FROM users WHERE email=$1", [email.toLowerCase()]);
  return r.rows[0] || null;
}
async function findUserById(id) {
  const r = await getPool().query("SELECT * FROM users WHERE id=$1", [id]);
  return r.rows[0] || null;
}

// ---- sessions ----
async function createSession(token, userId) {
  await getPool().query("INSERT INTO sessions(token,user_id) VALUES($1,$2)", [token, userId]);
}
async function findUserBySession(token) {
  const r = await getPool().query(
    "SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=$1", [token]);
  return r.rows[0] || null;
}
async function deleteSession(token) {
  await getPool().query("DELETE FROM sessions WHERE token=$1", [token]);
}

// ---- agents ----
async function createAgent(a) {
  await getPool().query(
    `INSERT INTO agents(id,name,capabilities,key_prefix,api_key_hash,token_limit,status,created_by)
     VALUES($1,$2,$3,$4,$5,$6,'active',$7)`,
    [a.id, a.name, JSON.stringify(a.capabilities || []), a.key_prefix, a.api_key_hash, a.token_limit || null, a.created_by]);
}
async function listAgents() {
  const r = await getPool().query("SELECT * FROM agents ORDER BY created_at DESC");
  return r.rows;
}
async function findAgentById(id) {
  const r = await getPool().query("SELECT * FROM agents WHERE id=$1", [id]);
  return r.rows[0] || null;
}
async function findAgentByKeyHash(hash) {
  const r = await getPool().query("SELECT * FROM agents WHERE api_key_hash=$1 AND status='active'", [hash]);
  return r.rows[0] || null;
}
async function updateAgentKey(id, hash, prefix) {
  await getPool().query("UPDATE agents SET api_key_hash=$1, key_prefix=$2 WHERE id=$3", [hash, prefix, id]);
}
async function revokeAgent(id) {
  await getPool().query("UPDATE agents SET status='revoked' WHERE id=$1", [id]);
}

// ---- tasks ----
async function createTask(t) {
  await getPool().query(
    "INSERT INTO tasks(id,title,description,status,subtasks,created_by) VALUES($1,$2,$3,$4,$5,$6)",
    [t.id, t.title, t.description || "", t.status, JSON.stringify(t.subtasks || []), t.created_by]);
}
async function listTasks() {
  const r = await getPool().query("SELECT * FROM tasks ORDER BY created_at DESC");
  return r.rows;
}
async function findTask(id) {
  const r = await getPool().query("SELECT * FROM tasks WHERE id=$1", [id]);
  return r.rows[0] || null;
}
async function saveTask(t) {
  await getPool().query("UPDATE tasks SET status=$1, subtasks=$2 WHERE id=$3",
    [t.status, JSON.stringify(t.subtasks), t.id]);
}

// ---- usage ----
async function logUsage(u) {
  await getPool().query(
    "INSERT INTO usage(id,agent_id,model,prompt_tokens,completion_tokens,total_tokens) VALUES($1,$2,$3,$4,$5,$6)",
    [uid("u"), u.agent_id, u.model, u.prompt_tokens, u.completion_tokens, u.total_tokens]);
}
async function agentUsageSince(agentId, since) {
  const r = await getPool().query(
    "SELECT COALESCE(SUM(total_tokens),0)::int AS s FROM usage WHERE agent_id=$1 AND at>=$2", [agentId, since]);
  return r.rows[0].s;
}
async function usageSummarySince(since) {
  const r = await getPool().query(
    `SELECT u.agent_id, a.name AS agent_name, a.token_limit,
            COUNT(*)::int AS calls,
            COALESCE(SUM(u.prompt_tokens),0)::int AS prompt_tokens,
            COALESCE(SUM(u.completion_tokens),0)::int AS completion_tokens,
            COALESCE(SUM(u.total_tokens),0)::int AS total_tokens
     FROM usage u LEFT JOIN agents a ON a.id=u.agent_id
     WHERE u.at>=$1 GROUP BY u.agent_id, a.name, a.token_limit`, [since]);
  return r.rows;
}

module.exports = {
  uid, init,
  countUsers, createUser, findUserByEmail, findUserById,
  createSession, findUserBySession, deleteSession,
  createAgent, listAgents, findAgentById, findAgentByKeyHash, updateAgentKey, revokeAgent,
  createTask, listTasks, findTask, saveTask,
  logUsage, agentUsageSince, usageSummarySince,
};
