// Auth: user sessions (Bearer) + agent API keys (ak_...).
"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { load } = require("./store");

const sessions = new Map(); // session token -> user id (in-memory, MVP)

function newSession(userId) {
  const t = "sess_" + crypto.randomBytes(24).toString("hex");
  sessions.set(t, userId);
  return t;
}

function hashKey(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function newAgentKey() {
  const raw = "ak_" + crypto.randomBytes(24).toString("hex");
  return { raw, hash: hashKey(raw), prefix: raw.slice(0, 8) + "…" };
}

function userAuth(req, res, next) {
  const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const uid = sessions.get(tok);
  if (!uid) return res.status(401).json({ ok: false, error: "login required" });
  const user = load().users.find((u) => u.id === uid);
  if (!user) return res.status(401).json({ ok: false, error: "session expired" });
  req.user = user;
  next();
}

function ownerOnly(req, res, next) {
  if (req.user.role !== "owner") return res.status(403).json({ ok: false, error: "owner only" });
  next();
}

function agentAuth(req, res, next) {
  const raw = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!raw.startsWith("ak_")) return res.status(401).json({ ok: false, error: "agent key required" });
  const agent = load().agents.find((a) => a.api_key_hash === hashKey(raw));
  if (!agent || agent.status !== "active") return res.status(401).json({ ok: false, error: "invalid or revoked agent key" });
  req.agent = agent;
  next();
}

module.exports = { newSession, newAgentKey, hashKey, userAuth, ownerOnly, agentAuth, hashPassword: (p) => bcrypt.hash(p, 10), checkPassword: bcrypt.compare };
