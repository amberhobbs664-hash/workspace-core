# workspace-core — the workspace itself

Users + AI agents share one workspace. Owner invites people, creates agent
identities (API keys), posts tasks, assigns subtasks. Agents poll their work,
call the LLM through the metered gateway, submit results. Every token is
logged per agent; limits are enforced.

## Run

```bash
cp .env.example .env   # add ROAR_API_KEY (server-side only, never shown to agents)
npm install
npm test   # LLM_MOCK=true — full flow, no network
npm start  # dashboard at http://localhost:3102/
```

First registered user becomes **owner**. Members can't manage agents.

## Agent quickstart (any AI agent with HTTP)

```bash
KEY=ak_...   # issued once at creation

# 1. see my work
curl -H "Authorization: Bearer $KEY" localhost:3102/api/agent/tasks

# 2. think via the metered gateway (tokens logged to me)
curl -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b","messages":[{"role":"user","content":"summarize X"}]}' \
  localhost:3102/api/agent/llm

# 3. submit result
curl -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"result":"..."}' localhost:3102/api/agent/subtasks/<subtask_id>/complete
```

## API

- `POST /api/auth/register` `{name,email,password}` → `{token, user}` (first = owner)
- `POST /api/auth/login` → `{token, user}`
- `POST /api/agents` (owner) `{name, capabilities[], token_limit}` → `{agent, api_key}` — key shown **once**
- `GET /api/agents` / `POST /api/agents/:id/regenerate` / `DELETE /api/agents/:id` (owner)
- `POST /api/tasks` `{title, description, subtasks: [...]}` → task with subtasks
- `GET /api/tasks`
- `POST /api/tasks/:id/assign` `{subtask_id, agent_id}`
- `GET /api/agent/tasks` (agent key) — my open subtasks
- `POST /api/agent/subtasks/:id/complete` (agent key) `{result}`
- `POST /api/agent/llm` (agent key) `{model, messages, ...}` — 429 when over token limit
- `GET /api/usage` (owner) — per-agent tokens this month

## Notes

- Sessions are in-memory (MVP) — restart logs users out; agent keys persist in `data/workspace.json` (`0600`).
- Token limits are monthly, per agent. Usage endpoint shows prompt/completion split.
- Production: Roar AI app hosting (Colombo), Postgres instead of the JSON file (Phase 1 hardening).
