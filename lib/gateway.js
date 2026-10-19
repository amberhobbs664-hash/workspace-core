// Metered LLM gateway: agents call the model through us, we log every token.
// Server-side key (ROAR_API_KEY) never reaches agents.
"use strict";

const { load, save } = require("./store");

const MOCK = process.env.LLM_MOCK === "true";
const BASE = (process.env.LLM_BASE_URL || "https://api.roar-ai.com/v1").replace(/\/$/, "");
const KEY = process.env.ROAR_API_KEY || "";

function monthStart(d = new Date()) {
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString();
}

function agentUsageThisMonth(agentId) {
  const since = monthStart();
  return load().usage
    .filter((u) => u.agent_id === agentId && u.at >= since)
    .reduce((s, u) => s + u.total_tokens, 0);
}

async function complete(agent, { model, messages, max_tokens, temperature }) {
  const used = agentUsageThisMonth(agent.id);
  if (agent.token_limit && used >= agent.token_limit) {
    const e = new Error(`token limit reached (${used}/${agent.token_limit} this month)`);
    e.status = 429;
    throw e;
  }

  let data;
  if (MOCK) {
    data = {
      choices: [{ message: { role: "assistant", content: "[mock] done." } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    };
  } else {
    if (!KEY) throw new Error("ROAR_API_KEY not set on server");
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: model || "llama-3.3-70b", messages, max_tokens, temperature }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error?.message || `LLM gateway HTTP ${res.status}`);
      e.status = 502;
      throw e;
    }
  }

  const u = data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const db = load();
  db.usage.push({
    agent_id: agent.id,
    model: model || "llama-3.3-70b",
    prompt_tokens: u.prompt_tokens || 0,
    completion_tokens: u.completion_tokens || 0,
    total_tokens: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
    at: new Date().toISOString(),
  });
  save(db);
  return data;
}

function usageSummary() {
  const db = load();
  const since = monthStart();
  const byAgent = {};
  for (const u of db.usage) {
    if (u.at < since) continue;
    byAgent[u.agent_id] = byAgent[u.agent_id] || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 };
    byAgent[u.agent_id].prompt_tokens += u.prompt_tokens;
    byAgent[u.agent_id].completion_tokens += u.completion_tokens;
    byAgent[u.agent_id].total_tokens += u.total_tokens;
    byAgent[u.agent_id].calls += 1;
  }
  return Object.entries(byAgent).map(([agent_id, s]) => {
    const a = db.agents.find((x) => x.id === agent_id) || {};
    return { agent_id, agent_name: a.name || "?", token_limit: a.token_limit || null, ...s };
  });
}

module.exports = { complete, agentUsageThisMonth, usageSummary };
