import { randomBytes } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readdir, stat, writeFile } from "node:fs/promises"
import net from "node:net"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { startOpenSweOAuthSession } from "./open-swe-oauth-session.mjs"
import {
  normalizeOpenSweBackendUrl,
  startOpenSweRemoteSession,
} from "./open-swe-remote-session.mjs"

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const t3Root = path.join(repositoryRoot, "t3code")
const t3Bin = path.join(t3Root, "apps/server/dist/bin.mjs")
const t3Client = path.join(t3Root, "apps/web/dist/index.html")
const stateRoot = path.join(repositoryRoot, ".t3code")
const oauthSource = path.join(repositoryRoot, "desktop/src/openai-oauth.cts")
const oauthModule = path.join(repositoryRoot, "desktop/build/openai-oauth.cjs")
const desktopConfigModule = path.join(
  repositoryRoot,
  "desktop/build/config.cjs"
)
const desktopLoginModule = path.join(
  repositoryRoot,
  "desktop/build/login-server.cjs"
)
const children = new Set()
let shuttingDown = false
let oauthSession
const execFileAsync = promisify(execFile)

function childExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
}

async function run(command, args, cwd, environment = process.env) {
  const child = spawn(command, args, {
    cwd,
    env: environment,
    stdio: "inherit",
  })
  children.add(child)
  const result = await childExit(child)
  children.delete(child)
  if (result.code !== 0) {
    throw new Error(
      `${command} exited with ${result.code ?? result.signal ?? "an error"}`
    )
  }
}

async function newestMtime(target, ignored = new Set()) {
  const entry = await stat(target)
  if (!entry.isDirectory()) return entry.mtimeMs
  let newest = 0
  for (const child of await readdir(target, { withFileTypes: true })) {
    if (ignored.has(child.name)) continue
    newest = Math.max(
      newest,
      await newestMtime(path.join(target, child.name), ignored)
    )
  }
  return newest
}

async function ensureT3Build() {
  if (!existsSync(path.join(t3Root, "package.json"))) {
    throw new Error(
      "The t3code submodule is missing. Run: git submodule update --init t3code"
    )
  }
  if (!existsSync(path.join(t3Root, "node_modules/.bin/vp"))) {
    await run(
      "corepack",
      ["pnpm@11.10.0", "install", "--frozen-lockfile"],
      t3Root
    )
  }

  const ignored = new Set(["dist", "node_modules", ".git", ".vite-plus"])
  const sharedSourceMtime = Math.max(
    await newestMtime(path.join(t3Root, "packages"), ignored),
    (await stat(path.join(t3Root, "pnpm-lock.yaml"))).mtimeMs
  )
  const webSourceMtime = Math.max(
    sharedSourceMtime,
    await newestMtime(path.join(t3Root, "apps/web"), ignored)
  )
  const serverSourceMtime = Math.max(
    sharedSourceMtime,
    await newestMtime(path.join(t3Root, "apps/server"), ignored)
  )
  const webNeedsBuild =
    !existsSync(t3Client) || (await stat(t3Client)).mtimeMs < webSourceMtime
  const serverNeedsBuild =
    !existsSync(t3Bin) || (await stat(t3Bin)).mtimeMs < serverSourceMtime

  if (webNeedsBuild) {
    await run(
      "corepack",
      ["pnpm@11.10.0", "--filter", "@t3tools/web", "build"],
      t3Root
    )
  }
  if (serverNeedsBuild) {
    await run(
      "corepack",
      ["pnpm@11.10.0", "--filter", "t3", "build:bundle"],
      t3Root
    )
  }
}

async function ensureOAuthModule() {
  const desktopSources = [
    oauthSource,
    path.join(repositoryRoot, "desktop/src/config.cts"),
    path.join(repositoryRoot, "desktop/src/login-server.cts"),
  ]
  const oldestOutput = [oauthModule, desktopConfigModule, desktopLoginModule]
    .filter(existsSync)
    .map(async (file) => (await stat(file)).mtimeMs)
  const newestSource = Math.max(
    ...(await Promise.all(
      desktopSources.map(async (file) => (await stat(file)).mtimeMs)
    ))
  )
  const needsBuild =
    oldestOutput.length !== 3 ||
    Math.min(...(await Promise.all(oldestOutput))) < newestSource
  if (needsBuild) {
    await run("pnpm", ["--dir", "desktop", "run", "build"], repositoryRoot)
  }
}

function takeOption(arguments_, names) {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    for (const name of names) {
      if (argument === name) {
        const value = arguments_[index + 1]
        if (!value || value.startsWith("--")) {
          throw new Error(`${name} requires a value`)
        }
        arguments_.splice(index, 2)
        return value
      }
      if (argument.startsWith(`${name}=`)) {
        arguments_.splice(index, 1)
        return argument.slice(name.length + 1)
      }
    }
  }
  return undefined
}

export function launcherOptions(argv, environment) {
  const forwardedArguments = argv.filter((argument) => argument !== "--")
  const remoteBackendUrl =
    takeOption(forwardedArguments, ["--open-swe-url", "--backend-url"]) ||
    environment.OPEN_SWE_BACKEND_URL ||
    environment.OPEN_SWE_DESKTOP_URL
  const directApiUrl =
    takeOption(forwardedArguments, ["--open-swe-api-url"]) ||
    (!remoteBackendUrl ? environment.OPEN_SWE_API_URL : undefined)
  const directApiToken =
    takeOption(forwardedArguments, ["--open-swe-api-token"]) ||
    environment.OPEN_SWE_API_TOKEN
  return {
    forwardedArguments,
    remoteBackendUrl: remoteBackendUrl?.trim() || undefined,
    directApiUrl: directApiUrl?.trim() || undefined,
    directApiToken: directApiToken?.trim() || undefined,
  }
}

async function openExternal(url) {
  console.log("Sign in to the remote Open SWE instance in your browser.")
  await run("open", [url], repositoryRoot)
}

export function githubRepositoryFromRemote(value) {
  const match = value
    .trim()
    .match(
      /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com(?:\/|:)([^/]+)\/([^/]+)$/i
    )
  return match ? `${match[1]}/${match[2].replace(/\.git$/i, "")}` : undefined
}

async function resolveRepository(environment) {
  if (environment.OPEN_SWE_REPOSITORY?.trim()) {
    return environment.OPEN_SWE_REPOSITORY.trim()
  }
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["remote", "get-url", "origin"],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      }
    )
    return githubRepositoryFromRemote(stdout)
  } catch {
    return undefined
  }
}

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string")
    throw new Error("Could not reserve a local port")
  const port = address.port
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return port
}

async function waitForBackend(url, token, exitPromise) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const result = await Promise.race([
      fetch(url, { headers: { authorization: `Bearer ${token}` } })
        .then((response) => (response.ok ? "ready" : "retry"))
        .catch(() => "retry"),
      exitPromise.then(() => "exited"),
    ])
    if (result === "ready") return
    if (result === "exited")
      throw new Error("Open SWE stopped before it became ready")
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("Timed out waiting for Open SWE to start")
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = childExit(child)
  child.kill("SIGTERM")
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ])
  if (!graceful && child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL")
}

async function stopAll() {
  if (shuttingDown) return
  shuttingDown = true
  await Promise.all([...children].map(stopChild))
  await oauthSession?.close()
  oauthSession = undefined
}

async function main() {
  await mkdir(stateRoot, { recursive: true })
  await ensureT3Build()
  const options = launcherOptions(process.argv.slice(2), process.env)
  const projectsFile = path.join(stateRoot, "projects.json")
  const artifactsDirectory = path.join(stateRoot, "artifacts")
  await mkdir(artifactsDirectory, { recursive: true })
  await writeFile(
    projectsFile,
    `${JSON.stringify([repositoryRoot], null, 2)}\n`,
    "utf8"
  )
  let backendUrl
  let apiToken
  let dashboardSession
  let backendExit
  let localMode = false
  if (options.remoteBackendUrl) {
    await ensureOAuthModule()
    const remote = await startOpenSweRemoteSession({
      baseUrl: options.remoteBackendUrl,
      storagePath: path.join(stateRoot, "remote-sessions.json"),
      configModulePath: desktopConfigModule,
      loginModulePath: desktopLoginModule,
      openExternal,
    })
    backendUrl = remote.baseUrl
    dashboardSession = remote.session
    console.log(
      `${remote.reused ? "Reusing" : "Saved"} remote Open SWE login for ${new URL(backendUrl).origin}`
    )
  } else if (options.directApiUrl) {
    backendUrl = normalizeOpenSweBackendUrl(options.directApiUrl)
    apiToken = options.directApiToken
  } else {
    localMode = true
    let oauthEnvironment = {}
    if (
      !process.env.OPENAI_API_KEY &&
      !process.env.OPEN_SWE_OPENAI_OAUTH_BROKER_URL
    ) {
      await ensureOAuthModule()
      const authFile = path.join(process.env.HOME, ".codex", "auth.json")
      oauthSession = await startOpenSweOAuthSession(oauthModule, authFile)
      oauthEnvironment = oauthSession.backendEnv()
    }
    const backendPort = await reservePort()
    backendUrl = `http://127.0.0.1:${backendPort}`
    apiToken = randomBytes(32).toString("base64url")
    const backend = spawn(
      "uv",
      [
        "run",
        "--python",
        "3.12",
        "langgraph",
        "dev",
        "--no-browser",
        "--no-reload",
        "--host",
        "127.0.0.1",
        "--port",
        String(backendPort),
        "--config",
        path.join(repositoryRoot, "langgraph.desktop.json"),
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ...oauthEnvironment,
          OPEN_SWE_LOCAL_AUTH_TOKEN: apiToken,
          OPEN_SWE_LOCAL_PROJECTS_FILE: projectsFile,
          OPEN_SWE_LOCAL_ARTIFACTS_DIR: artifactsDirectory,
          PYTHONUNBUFFERED: "1",
        },
        stdio: "inherit",
      }
    )
    children.add(backend)
    backendExit = childExit(backend)
    await waitForBackend(backendUrl, apiToken, backendExit)
  }

  const repository = await resolveRepository(process.env)
  const web = spawn(
    process.execPath,
    [
      t3Bin,
      "--base-dir",
      path.join(stateRoot, "t3"),
      "--auto-bootstrap-project-from-cwd",
      ...options.forwardedArguments,
      repositoryRoot,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        OPEN_SWE_PROVIDER_ONLY: "1",
        OPEN_SWE_API_URL: backendUrl,
        ...(apiToken ? { OPEN_SWE_API_TOKEN: apiToken } : {}),
        ...(dashboardSession
          ? {
              OPEN_SWE_DASHBOARD_SESSION: dashboardSession,
              OPEN_SWE_DASHBOARD_URL: backendUrl,
            }
          : {}),
        OPEN_SWE_GRAPH_ID: "agent",
        OPEN_SWE_LOCAL_MODE: localMode ? "1" : "0",
        ...(repository ? { OPEN_SWE_REPOSITORY: repository } : {}),
      },
      stdio: "inherit",
    }
  )
  children.add(web)
  const webExit = childExit(web)
  const result = backendExit
    ? await Promise.race([
        webExit.then((exit) => ({ process: "web", exit })),
        backendExit.then((exit) => ({ process: "backend", exit })),
      ])
    : { process: "web", exit: await webExit }
  if (result.process === "backend") {
    throw new Error(
      `Open SWE exited with ${result.exit.code ?? result.exit.signal ?? "an error"}`
    )
  }
  process.exitCode = result.exit.code ?? (result.exit.signal ? 1 : 0)
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stopAll().finally(() => {
        process.exitCode = signal === "SIGINT" ? 130 : 143
      })
    })
  }

  try {
    await main()
  } catch (error) {
    process.exitCode = 1
    console.error(error instanceof Error ? error.message : error)
  } finally {
    await stopAll()
  }
}
