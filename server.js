// workspace-core: users + agents + tasks + metered LLM gateway. Postgres-backed.
"use strict";

require("dotenv").config();
const express = require("express");
const path = require("path");
const store = require("./lib/store");
const auth = require("./lib/auth");
const gateway = require("./lib/gateway");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3102;

const publicAgent = (a) => ({
  id: a.id, name: a.name,
  capabilities: Array.isArray(a.capabilities) ? a.capabilities : JSON.parse(a.capabilities || "[]"),
  key_prefix: a.key_prefix, token_limit: a.token_limit, status: a.status, created_at: a.created_at,
});
const publicTask = (t) => ({
  ...t,
  subtasks: Array.isArray(t.subtasks) ? t.subtasks : JSON.parse(t.subtasks || "[]"),
});

// ---------- auth ----------
app.post("/api/auth/register", async (req, res) => {
  try {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ ok: false, error: "name, email, password required" });
    if (await store.findUserByEmail(email)) return res.status(409).json({ ok: false, error: "email already registered" });
    const user = {
      id: store.uid("u"), name, email: email.toLowerCase(),
      pass_hash: await auth.hashPassword(password),
      role: (await store.countUsers()) === 0 ? "owner" : "member",
    };
    await store.createUser(user);
    const token = auth.newSessionToken();
    await store.createSession(token, user.id);
    res.json({ ok: true, token, user: { id: user.id, name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await store.findUserByEmail(email || "");
    if (!user || !(await auth.checkPassword(password || "", user.pass_hash)))
      return res.status(401).json({ ok: false, error: "invalid email or password" });
    const token = auth.newSessionToken();
    await store.createSession(token, user.id);
    res.json({ ok: true, token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/auth/logout", auth.userAuth, async (req, res) => {
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  await store.deleteSession(tok);
  res.json({ ok: true });
});

app.get("/api/me", auth.userAuth, (req, res) => {
  const { pass_hash, ...safe } = req.user;
  res.json({ ok: true, user: safe });
});

// ---------- agents ----------
app.post("/api/agents", auth.userAuth, auth.ownerOnly, async (req, res) => {
  try {
    const { name, capabilities = [], token_limit = null } = req.body || {};
    if (!name) return res.status(400).json({ ok: false, error: "name required" });
    const { raw, hash, prefix } = auth.newAgentKey();
    const agent = {
      id: store.uid("ag"), name, capabilities, key_prefix: prefix,
      api_key_hash: hash, token_limit, created_by: req.user.id,
    };
    await store.createAgent(agent);
    const row = await store.findAgentById(agent.id);
    res.json({ ok: true, agent: publicAgent(row), api_key: raw }); // key shown ONCE
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/agents", auth.userAuth, async (req, res) => {
  const agents = await store.listAgents();
  res.json({ ok: true, agents: agents.map(publicAgent) });
});

app.post("/api/agents/:id/regenerate", auth.userAuth, auth.ownerOnly, async (req, res) => {
  const a = await store.findAgentById(req.params.id);
  if (!a) return res.status(404).json({ ok: false, error: "agent not found" });
  const { raw, hash, prefix } = auth.newAgentKey();
  await store.updateAgentKey(a.id, hash, prefix);
  res.json({ ok: true, api_key: raw });
});

app.delete("/api/agents/:id", auth.userAuth, auth.ownerOnly, async (req, res) => {
  await store.revokeAgent(req.params.id);
  res.json({ ok: true });
});

// ---------- tasks ----------
function taskStatus(t) {
  const subs = Array.isArray(t.subtasks) ? t.subtasks : JSON.parse(t.subtasks || "[]");
  if (subs.length && subs.every((s) => s.status === "done")) return "done";
  if (subs.some((s) => s.status !== "open")) return "in_progress";
  return "open";
}

app.post("/api/tasks", auth.userAuth, async (req, res) => {
  try {
    const { title, description = "", subtasks = [] } = req.body || {};
    if (!title) return res.status(400).json({ ok: false, error: "title required" });
    const task = {
      id: store.uid("t"), title, description,
      subtasks: subtasks.map((s) => ({
        id: store.uid("st"), title: typeof s === "string" ? s : s.title,
        status: "open", agent_id: null, result: null, updated_at: new Date().toISOString(),
      })),
      created_by: req.user.id,
    };
    task.status = taskStatus(task);
    await store.createTask(task);
    res.json({ ok: true, task: publicTask(task) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get("/api/tasks", auth.userAuth, async (req, res) => {
  const tasks = await store.listTasks();
  res.json({ ok: true, tasks: tasks.map(publicTask) });
});

app.post("/api/tasks/:id/assign", auth.userAuth, async (req, res) => {
  try {
    const { subtask_id, agent_id } = req.body || {};
    const t = await store.findTask(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "task not found" });
    const agent = await store.findAgentById(agent_id);
    if (!agent || agent.status !== "active") return res.status(404).json({ ok: false, error: "agent not found or revoked" });
    const task = publicTask(t);
    const st = task.subtasks.find((s) => s.id === subtask_id);
    if (!st) return res.status(404).json({ ok: false, error: "subtask not found" });
    st.agent_id = agent.id; st.status = "assigned"; st.updated_at = new Date().toISOString();
    task.status = taskStatus(task);
    await store.saveTask(task);
    res.json({ ok: true, task: publicTask({ ...t, ...task }) });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ---------- agent surface ----------
app.get("/api/agent/tasks", auth.agentAuth, async (req, res) => {
  const mine = [];
  for (const t of await store.listTasks()) {
    const task = publicTask(t);
    for (const s of task.subtasks) {
      if (s.agent_id === req.agent.id && s.status !== "done")
        mine.push({ task_id: task.id, task_title: task.title, task_description: task.description, subtask: s });
    }
  }
  res.json({ ok: true, agent: req.agent.name, tasks: mine });
});

app.post("/api/agent/subtasks/:id/complete", auth.agentAuth, async (req, res) => {
  try {
    const { result = "" } = req.body || {};
    const tasks = await store.listTasks();
    let target = null;
    for (const t of tasks) {
      const task = publicTask(t);
      const s = task.subtasks.find((x) => x.id === req.params.id && x.agent_id === req.agent.id);
      if (s) { target = { t, task, s }; break; }
    }
    if (!target) return res.status(404).json({ ok: false, error: "subtask not found or not assigned to you" });
    target.s.status = "done"; target.s.result = result; target.s.updated_at = new Date().toISOString();
    target.task.status = taskStatus(target.task);
    await store.saveTask(target.task);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
app.get("/api/usage", auth.userAuth, auth.ownerOnly, async (req, res) => {
  res.json({ ok: true, month: new Date().toISOString().slice(0, 7), usage: await gateway.usageSummary() });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "workspace-core", version: "0.2.0", store: process.env.DATABASE_URL ? "postgres" : "memory", llm_mock: process.env.LLM_MOCK === "true", time: new Date().toISOString() });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));

store.init()
  .then(() => app.listen(PORT, () => console.log(`workspace-core on :${PORT} store=${process.env.DATABASE_URL ? "postgres" : "memory"}`)))
  .catch((e) => { console.error("store init failed:", e.message); process.exit(1); });
