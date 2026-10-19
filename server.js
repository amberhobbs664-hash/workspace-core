// workspace-core: users + agents + tasks + metered LLM gateway.
"use strict";

require("dotenv").config();
const express = require("express");
const path = require("path");
const { load, save, uid } = require("./lib/store");
const auth = require("./lib/auth");
const gateway = require("./lib/gateway");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3102;

const publicAgent = (a) => ({
  id: a.id, name: a.name, capabilities: a.capabilities,
  key_prefix: a.key_prefix, token_limit: a.token_limit, status: a.status, created_at: a.created_at,
});

// ---------- auth ----------
app.post("/api/auth/register", async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ ok: false, error: "name, email, password required" });
  const db = load();
  if (db.users.some((u) => u.email === email.toLowerCase()))
    return res.status(409).json({ ok: false, error: "email already registered" });
  const user = {
    id: uid("u"), name, email: email.toLowerCase(),
    pass_hash: await auth.hashPassword(password),
    role: db.users.length === 0 ? "owner" : "member", // first user owns the workspace
    created_at: new Date().toISOString(),
  };
  db.users.push(user);
  save(db);
  res.json({ ok: true, token: auth.newSession(user.id), user: { id: user.id, name, email: user.email, role: user.role } });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  const user = load().users.find((u) => u.email === (email || "").toLowerCase());
  if (!user || !(await auth.checkPassword(password || "", user.pass_hash)))
    return res.status(401).json({ ok: false, error: "invalid email or password" });
  res.json({ ok: true, token: auth.newSession(user.id), user: { id: user.id, name: user.name, email: user.email, role: user.role } });
});

app.get("/api/me", auth.userAuth, (req, res) => {
  const { pass_hash, ...safe } = req.user;
  res.json({ ok: true, user: safe });
});

// ---------- agents ----------
app.post("/api/agents", auth.userAuth, auth.ownerOnly, (req, res) => {
  const { name, capabilities = [], token_limit = null } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: "name required" });
  const { raw, hash, prefix } = auth.newAgentKey();
  const db = load();
  const agent = {
    id: uid("ag"), name, capabilities, key_prefix: prefix,
    api_key_hash: hash, token_limit, status: "active",
    created_at: new Date().toISOString(), created_by: req.user.id,
  };
  db.agents.push(agent);
  save(db);
  res.json({ ok: true, agent: publicAgent(agent), api_key: raw }); // key shown ONCE
});

app.get("/api/agents", auth.userAuth, (req, res) => {
  res.json({ ok: true, agents: load().agents.map(publicAgent) });
});

app.post("/api/agents/:id/regenerate", auth.userAuth, auth.ownerOnly, (req, res) => {
  const db = load();
  const a = db.agents.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: "agent not found" });
  const { raw, hash, prefix } = auth.newAgentKey();
  a.api_key_hash = hash; a.key_prefix = prefix;
  save(db);
  res.json({ ok: true, api_key: raw });
});

app.delete("/api/agents/:id", auth.userAuth, auth.ownerOnly, (req, res) => {
  const db = load();
  const a = db.agents.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: "agent not found" });
  a.status = "revoked";
  save(db);
  res.json({ ok: true });
});

// ---------- tasks ----------
function taskStatus(t) {
  if (t.subtasks.every((s) => s.status === "done")) return "done";
  if (t.subtasks.some((s) => s.status !== "open")) return "in_progress";
  return "open";
}

app.post("/api/tasks", auth.userAuth, (req, res) => {
  const { title, description = "", subtasks = [] } = req.body || {};
  if (!title) return res.status(400).json({ ok: false, error: "title required" });
  const db = load();
  const task = {
    id: uid("t"), title, description,
    subtasks: subtasks.map((s) => ({
      id: uid("st"), title: typeof s === "string" ? s : s.title,
      status: "open", agent_id: null, result: null, updated_at: new Date().toISOString(),
    })),
    created_by: req.user.id, created_at: new Date().toISOString(),
  };
  task.status = taskStatus(task);
  db.tasks.push(task);
  save(db);
  res.json({ ok: true, task });
});

app.get("/api/tasks", auth.userAuth, (req, res) => {
  res.json({ ok: true, tasks: load().tasks });
});

app.post("/api/tasks/:id/assign", auth.userAuth, (req, res) => {
  const { subtask_id, agent_id } = req.body || {};
  const db = load();
  const task = db.tasks.find((t) => t.id === req.params.id);
  const agent = db.agents.find((a) => a.id === agent_id && a.status === "active");
  if (!task) return res.status(404).json({ ok: false, error: "task not found" });
  if (!agent) return res.status(404).json({ ok: false, error: "agent not found or revoked" });
  const st = task.subtasks.find((s) => s.id === subtask_id);
  if (!st) return res.status(404).json({ ok: false, error: "subtask not found" });
  st.agent_id = agent.id; st.status = "assigned"; st.updated_at = new Date().toISOString();
  task.status = taskStatus(task);
  save(db);
  res.json({ ok: true, task });
});

// ---------- agent surface ----------
app.get("/api/agent/tasks", auth.agentAuth, (req, res) => {
  const mine = [];
  for (const t of load().tasks) {
    for (const s of t.subtasks) {
      if (s.agent_id === req.agent.id && s.status !== "done")
        mine.push({ task_id: t.id, task_title: t.title, task_description: t.description, subtask: s });
    }
  }
  res.json({ ok: true, agent: req.agent.name, tasks: mine });
});

app.post("/api/agent/subtasks/:id/complete", auth.agentAuth, (req, res) => {
  const { result = "" } = req.body || {};
  const db = load();
  let found = null;
  for (const t of db.tasks) {
    const s = t.subtasks.find((x) => x.id === req.params.id && x.agent_id === req.agent.id);
    if (s) { found = { t, s }; break; }
  }
  if (!found) return res.status(404).json({ ok: false, error: "subtask not found or not assigned to you" });
  found.s.status = "done"; found.s.result = result; found.s.updated_at = new Date().toISOString();
  found.t.status = taskStatus(found.t);
  save(db);
  res.json({ ok: true });
});

app.post("/api/agent/llm", auth.agentAuth, async (req, res) => {
  try {
    const { model, messages, max_tokens, temperature } = req.body || {};
    if (!Array.isArray(messages) || !messages.length)
      return res.status(400).json({ ok: false, error: "messages[] required" });
    const data = await gateway.complete(req.agent, { model, messages, max_tokens, temperature });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

// ---------- usage ----------
app.get("/api/usage", auth.userAuth, auth.ownerOnly, (req, res) => {
  res.json({ ok: true, month: new Date().toISOString().slice(0, 7), usage: gateway.usageSummary() });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "workspace-core", version: "0.1.0", llm_mock: process.env.LLM_MOCK === "true", time: new Date().toISOString() });
});

app.listen(PORT, () => console.log(`workspace-core on :${PORT}  (llm_mock=${process.env.LLM_MOCK === "true"})`));
