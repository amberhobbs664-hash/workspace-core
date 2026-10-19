// JSON file store: users, agents, tasks, usage log.
"use strict";

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "workspace.json");

function blank() {
  return { users: [], agents: [], tasks: [], usage: [] };
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return blank();
    throw e;
  }
}

function save(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), { mode: 0o600 });
}

const uid = (p) => p + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

module.exports = { load, save, uid };
