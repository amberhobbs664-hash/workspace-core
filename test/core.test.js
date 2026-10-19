// Full workspace-core flow in LLM_MOCK=true (no network, no API key needed).
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 3211;
const BASE = `http://127.0.0.1:${PORT}`;
const ENV = { ...process.env, PORT: String(PORT), LLM_MOCK: "true", ALLOW_MEMORY_STORE: "true" };

let pass = 0, fail = 0;
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
async function j(res) { const b = await res.json().catch(() => ({})); return { status: res.status, ...b }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const H = (t) => ({ "Content-Type": "application/json", Authorization: `Bearer ${t}` });

(async () => {
  fs.rmSync(path.join(__dirname, "..", "data"), { recursive: true, force: true });

  const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env: ENV, stdio: ["ignore", "pipe", "pipe"] });
  let started = false;
  child.stdout.on("data", (d) => { if (d.toString().includes("workspace-core on")) started = true; });
  child.stderr.on("data", (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await sleep(200);
  ok("server boots", started);

  let userTok, agentKey, agentId, taskId, subId, limitedKey;
  try {
    let r = await j(await fetch(`${BASE}/api/health`));
    ok("GET /api/health", r.ok === true && r.llm_mock === true);

    r = await j(await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: H(""), body: JSON.stringify({ name: "Owner", email: "owner@test.lk", password: "secret123" }) }));
    ok("register -> first user is owner", r.ok && r.user.role === "owner" && !!r.token);
    userTok = r.token;

    r = await j(await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: H(""), body: JSON.stringify({ email: "owner@test.lk", password: "secret123" }) }));
    ok("login works", r.ok && !!r.token);

    r = await j(await fetch(`${BASE}/api/agents`, { method: "POST", headers: H(userTok), body: JSON.stringify({ name: "researcher-1", capabilities: ["research"], token_limit: 100000 }) }));
    ok("create agent issues api key once", r.ok && r.api_key.startsWith("ak_"));
    agentKey = r.api_key; agentId = r.agent.id;

    r = await j(await fetch(`${BASE}/api/agents`, { headers: H(userTok) }));
    ok("agent key hash never exposed", r.ok && r.agents.length === 1 && !("api_key_hash" in r.agents[0]));

    r = await j(await fetch(`${BASE}/api/agent/tasks`, { headers: H("ak_bogus") }));
    ok("bad agent key -> 401", r.status === 401);

    r = await j(await fetch(`${BASE}/api/tasks`, { method: "POST", headers: H(userTok), body: JSON.stringify({ title: "Launch post", description: "d", subtasks: ["Write caption", "Pick image"] }) }));
    ok("create task with subtasks", r.ok && r.task.subtasks.length === 2 && r.task.status === "open");
    taskId = r.task.id; subId = r.task.subtasks[0].id;

    r = await j(await fetch(`${BASE}/api/tasks/${taskId}/assign`, { method: "POST", headers: H(userTok), body: JSON.stringify({ subtask_id: subId, agent_id: agentId }) }));
    ok("assign subtask to agent", r.ok && r.task.status === "in_progress");

    r = await j(await fetch(`${BASE}/api/agent/tasks`, { headers: H(agentKey) }));
    ok("agent sees assigned work", r.ok && r.tasks.length === 1 && r.tasks[0].subtask.id === subId);

    r = await j(await fetch(`${BASE}/api/agent/llm`, { method: "POST", headers: H(agentKey), body: JSON.stringify({ model: "llama-3.3-70b", messages: [{ role: "user", content: "hi" }] }) }));
    ok("agent LLM call proxied (mock)", r.ok && r.choices?.[0]?.message?.content === "[mock] done.");

    r = await j(await fetch(`${BASE}/api/agent/subtasks/${subId}/complete`, { method: "POST", headers: H(agentKey), body: JSON.stringify({ result: "caption drafted" }) }));
    ok("agent completes subtask", r.ok === true);

    r = await j(await fetch(`${BASE}/api/usage`, { headers: H(userTok) }));
    const u = (r.usage || []).find((x) => x.agent_id === agentId);
    ok("usage metered per agent", r.ok && u && u.total_tokens === 20 && u.calls === 1, JSON.stringify(u));

    // token limit enforced
    r = await j(await fetch(`${BASE}/api/agents`, { method: "POST", headers: H(userTok), body: JSON.stringify({ name: "limited-1", token_limit: 1 }) }));
    limitedKey = r.api_key;
    await fetch(`${BASE}/api/agent/llm`, { method: "POST", headers: H(limitedKey), body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) });
    r = await j(await fetch(`${BASE}/api/agent/llm`, { method: "POST", headers: H(limitedKey), body: JSON.stringify({ messages: [{ role: "user", content: "x" }] }) }));
    ok("token limit blocks over-budget agent", r.status === 429);

    // revoke
    r = await j(await fetch(`${BASE}/api/agents/${agentId}`, { method: "DELETE", headers: H(userTok) }));
    r = await j(await fetch(`${BASE}/api/agent/tasks`, { headers: H(agentKey) }));
    ok("revoked agent key -> 401", r.status === 401);

    // member cannot manage agents
    r = await j(await fetch(`${BASE}/api/auth/register`, { method: "POST", headers: H(""), body: JSON.stringify({ name: "M2", email: "m2@test.lk", password: "secret123" }) }));
    const mTok = r.token;
    r = await j(await fetch(`${BASE}/api/agents`, { method: "POST", headers: H(mTok), body: JSON.stringify({ name: "x" }) }));
    ok("member cannot create agents (owner only)", r.status === 403);
  } finally {
    child.kill();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
