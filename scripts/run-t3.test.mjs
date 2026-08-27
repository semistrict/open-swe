import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  normalizeOpenSweBackendUrl,
  startOpenSweRemoteSession,
} from "./open-swe-remote-session.mjs"
import { githubRepositoryFromRemote, launcherOptions } from "./run-t3.mjs"

test("selects a remote backend without forwarding launcher flags", () => {
  assert.deepEqual(
    launcherOptions(
      ["--", "--backend-url", "https://swe.example.test/path", "--no-browser"],
      {}
    ),
    {
      forwardedArguments: ["--no-browser"],
      remoteBackendUrl: "https://swe.example.test/path",
      directApiUrl: undefined,
      directApiToken: undefined,
    }
  )
})

test("supports a direct API endpoint and token", () => {
  assert.deepEqual(
    launcherOptions(
      [
        "--open-swe-api-url=https://graph.example.test",
        "--open-swe-api-token",
        "secret",
      ],
      {}
    ),
    {
      forwardedArguments: [],
      remoteBackendUrl: undefined,
      directApiUrl: "https://graph.example.test",
      directApiToken: "secret",
    }
  )
})

test("derives the remote repository for new remote threads", () => {
  assert.equal(
    githubRepositoryFromRemote("git@github.com:langchain-ai/open-swe.git"),
    "langchain-ai/open-swe"
  )
  assert.equal(
    githubRepositoryFromRemote("https://github.com/langchain-ai/open-swe.git"),
    "langchain-ai/open-swe"
  )
})

test("normalizes backend URLs without accepting embedded credentials", () => {
  assert.equal(
    normalizeOpenSweBackendUrl("https://swe.example.test/path?q=1#fragment"),
    "https://swe.example.test/"
  )
  assert.throws(
    () => normalizeOpenSweBackendUrl("https://user:pass@swe.example.test"),
    /must not include credentials/
  )
})

test("reuses a valid stored remote session without starting a login", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "open-swe-t3-test-"))
  const storagePath = path.join(directory, "sessions.json")
  await writeFile(
    storagePath,
    JSON.stringify({
      version: 1,
      sessions: {
        "https://swe.example.test/": { session: "existing-session" },
      },
    })
  )
  const requests = []
  const result = await startOpenSweRemoteSession({
    baseUrl: "https://swe.example.test",
    storagePath,
    configModulePath: "/unused/config.cjs",
    loginModulePath: "/unused/login.cjs",
    openExternal: async () => assert.fail("login should not open"),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), headers: init?.headers })
      return new Response(JSON.stringify({ login: "octocat" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    },
  })

  assert.equal(result.reused, true)
  assert.equal(result.session, "existing-session")
  assert.equal(requests[0].url, "https://swe.example.test/dashboard/api/me")
  assert.equal(requests[0].headers.cookie, "osw_session=existing-session")
})
