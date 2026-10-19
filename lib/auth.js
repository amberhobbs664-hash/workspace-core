// Auth: user sessions (Bearer, persisted) + agent API keys (ak_...).
"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const store = require("./store");

function newSessionToken() {
  return "sess_" + crypto.randomBytes(24).toString("hex");
}

function hashKey(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function newAgentKey() {
  const raw = "ak_" + crypto.randomBytes(24).toString("hex");
  return { raw, hash: hashKey(raw), prefix: raw.slice(0, 8) + "…" };
}

function bearer(req) {
  return (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
}

async function userAuth(req, res, next) {
  try {
    const user = await store.findUserBySession(bearer(req));
    if (!user) return res.status(401).json({ ok: false, error: "login required" });
    req.user = user;
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: "auth failed" });
  }
}

function ownerOnly(req, res, next) {
  if (req.user.role !== "owner") return res.status(403).json({ ok: false, error: "owner only" });
  next();
}

async function agentAuth(req, res, next) {
  try {
    const raw = bearer(req);
    if (!raw.startsWith("ak_")) return res.status(401).json({ ok: false, error: "agent key required" });
    const agent = await store.findAgentByKeyHash(hashKey(raw));
    if (!agent) return res.status(401).json({ ok: false, error: "invalid or revoked agent key" });
    req.agent = agent;
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: "auth failed" });
  }
}

module.exports = {
  newSessionToken, newAgentKey, hashKey, userAuth, ownerOnly, agentAuth,
  hashPassword: (p) => bcrypt.hash(p, 10), checkPassword: bcrypt.compare,
};
