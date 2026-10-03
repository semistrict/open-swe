#!/bin/sh
# One-time setup of a checkout or worktree for `make dev` / `make dev-ui`. Safe to rerun:
# it installs dependencies and fills in only what .env is missing, never overwriting a value.
set -eu
cd "$(git rev-parse --show-toplevel)"

fail() { echo "dev-init: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required: $2"; }
value() { sh scripts/dotenv_value.sh .env "$1"; }

# Sets KEY in .env when it is empty or absent. Every existing assignment is rewritten so
# the last one, which is the one python-dotenv keeps, carries the value too.
fill() {
  key=$1
  new=$2
  [ -z "$(value "$key")" ] || return 0
  tmp=$(mktemp .env.dev-init.XXXXXX)
  awk -v key="$key" -v new="$new" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "=" { print key "=\"" new "\""; found = 1; next }
    { print }
    END { if (!found) print key "=\"" new "\"" }
  ' .env >"$tmp"
  mv "$tmp" .env
  echo "dev-init: set $key in .env"
}

need uv https://docs.astral.sh/uv/
need pnpm https://pnpm.io/installation

uv sync --extra dev
pnpm install --frozen-lockfile

# A worktree starts from the primary checkout's .env: its keys and app credentials. Nothing
# per-checkout lives there, so the copy cannot make two checkouts share state.
if [ ! -e .env ]; then
  primary=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
  if [ "$primary" != "$PWD" ] && [ -r "$primary/.env" ]; then
    cp "$primary/.env" .env
    echo "dev-init: copied .env from $primary"
  else
    cp .env.example .env
    echo "dev-init: created .env from .env.example"
  fi
  chmod 600 .env
fi

fill TOKEN_ENCRYPTION_KEY "$(uv run --no-sync python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"
fill DASHBOARD_JWT_SECRET "$(openssl rand -hex 32)"

if command -v gh >/dev/null 2>&1 && login=$(gh api user --jq .login 2>/dev/null); then
  [ -n "$(value ALLOWED_GITHUB_ORGS)" ] || fill ALLOWED_GITHUB_USERS "$login"
  fill CONFIGURED_ADMINS "$login"
elif [ -z "$(value ALLOWED_GITHUB_USERS)$(value ALLOWED_GITHUB_ORGS)" ]; then
  echo "dev-init: log in with 'gh auth login' and rerun, or set ALLOWED_GITHUB_USERS in .env" >&2
fi

# This checkout's own Postgres, on the first port no other checkout has claimed or is using.
if [ -z "${POSTGRES_URI:-$(value POSTGRES_URI)}" ]; then
  need docker https://docs.docker.com/get-docker/
  need lsof https://github.com/lsof-org/lsof
  docker info >/dev/null 2>&1 || fail "the Docker daemon is not running; start it and rerun"
  state=${DEV_STATE_DIR:?run this through make dev-init}
  mkdir -p "$state"
  if [ ! -s "$state/postgres-port" ]; then
    port=54320
    while cat "$HOME"/.open-swe/*/postgres-port 2>/dev/null | grep -qx "$port" ||
      lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
      port=$((port + 1))
    done
    echo "$port" >"$state/postgres-port"
  fi
  make --no-print-directory postgres
fi

# Without a provider key, OpenAI models run on a ChatGPT subscription. Share the token
# store Deep Agents Code signs in to when there is one; `make chatgpt-login` writes it otherwise.
models="ANTHROPIC_API_KEY OPENAI_API_KEY GOOGLE_API_KEY GROQ_API_KEY FIREWORKS_API_KEY BASETEN_API_KEY"
configured=""
for key in $models; do configured="$configured$(value "$key")"; done
if [ -z "$configured" ]; then
  store="$HOME/.deepagents/.state/chatgpt-auth.json"
  [ -e "$store" ] || store="$HOME/.langchain/chatgpt-auth.json"
  fill OPEN_SWE_OPENAI_OAUTH_TOKEN_FILE "$store"
  token_file=$(value OPEN_SWE_OPENAI_OAUTH_TOKEN_FILE)
  case $token_file in "~/"*) token_file="$HOME/${token_file#"~/"}" ;; esac
  [ -e "$token_file" ] || echo "dev-init: no model key in .env; sign in with ChatGPT: make chatgpt-login" >&2
fi

echo "dev-init: done. Start with 'make dev-ui'."
