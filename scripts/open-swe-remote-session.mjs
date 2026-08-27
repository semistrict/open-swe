import { createRequire } from "node:module"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

const require = createRequire(import.meta.url)

export function normalizeOpenSweBackendUrl(value) {
  const url = new URL(value.trim())
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Open SWE backend URL must use http or https")
  }
  if (url.username || url.password) {
    throw new Error("Open SWE backend URL must not include credentials")
  }
  url.pathname = "/"
  url.hash = ""
  url.search = ""
  return url.toString()
}

async function readStore(storagePath) {
  try {
    const parsed = JSON.parse(await readFile(storagePath, "utf8"))
    return parsed?.version === 1 &&
      parsed.sessions &&
      typeof parsed.sessions === "object"
      ? parsed
      : { version: 1, sessions: {} }
  } catch {
    return { version: 1, sessions: {} }
  }
}

async function writeStore(storagePath, store) {
  await mkdir(path.dirname(storagePath), { recursive: true })
  const temporary = `${storagePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, {
    mode: 0o600,
  })
  await rename(temporary, storagePath)
}

function sessionHeaders(session, extra = {}) {
  return {
    ...extra,
    cookie: `osw_session=${session}`,
  }
}

async function readProfile(baseUrl, session, fetchImpl) {
  const response = await fetchImpl(new URL("/dashboard/api/me", baseUrl), {
    headers: sessionHeaders(session, { accept: "application/json" }),
  })
  if (!response.ok) return null
  const profile = await response.json()
  return profile && typeof profile === "object" ? profile : null
}

export async function startOpenSweRemoteSession(input) {
  const baseUrl = normalizeOpenSweBackendUrl(input.baseUrl)
  const fetchImpl = input.fetchImpl ?? fetch
  const store = await readStore(input.storagePath)
  const existing = store.sessions[baseUrl]
  if (typeof existing?.session === "string" && existing.session) {
    const profile = await readProfile(
      baseUrl,
      existing.session,
      fetchImpl
    ).catch(() => null)
    if (profile) {
      return { baseUrl, session: existing.session, profile, reused: true }
    }
  }

  const { beginLogin } = require(input.loginModulePath)
  const { desktopExchangeUrl, desktopLoginUrl } = require(
    input.configModulePath
  )
  const flow = await beginLogin()
  try {
    await input.openExternal(desktopLoginUrl(baseUrl, flow))
    const code = await flow.code
    if (!code) throw new Error("Remote Open SWE sign-in was canceled")
    const response = await fetchImpl(desktopExchangeUrl(baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "open-swe://app",
      },
      body: JSON.stringify({ code, verifier: flow.verifier }),
    })
    if (!response.ok) {
      throw new Error(`Remote Open SWE rejected sign-in (${response.status})`)
    }
    const payload = await response.json()
    if (typeof payload?.session !== "string" || !payload.session) {
      throw new Error("Remote Open SWE returned no session")
    }
    const profile = await readProfile(baseUrl, payload.session, fetchImpl)
    if (!profile) throw new Error("Remote Open SWE session validation failed")
    store.sessions[baseUrl] = {
      session: payload.session,
      expiresAt:
        Date.now() + Math.max(0, Number(payload.expires_in) || 0) * 1000,
    }
    await writeStore(input.storagePath, store)
    return { baseUrl, session: payload.session, profile, reused: false }
  } finally {
    flow.cancel()
  }
}
