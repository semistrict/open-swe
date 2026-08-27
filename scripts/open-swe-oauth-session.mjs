import { createRequire } from "node:module"
import { readFileSync } from "node:fs"

const require = createRequire(import.meta.url)

function readLocalCredentials(storagePath) {
  const stored = JSON.parse(readFileSync(storagePath, "utf8"))
  return {
    accessToken: stored.tokens?.access_token,
    refreshToken: stored.tokens?.refresh_token,
    idToken: stored.tokens?.id_token,
    accountId: stored.tokens?.account_id,
    refreshedAt: Date.parse(stored.last_refresh),
  }
}

function updateLocalCredentials(storagePath, serialized) {
  const stored = JSON.parse(readFileSync(storagePath, "utf8"))
  const credentials = JSON.parse(serialized)
  return Buffer.from(
    JSON.stringify({
      ...stored,
      last_refresh: new Date(credentials.refreshedAt).toISOString(),
      tokens: {
        ...stored.tokens,
        access_token: credentials.accessToken,
        refresh_token: credentials.refreshToken,
        id_token: credentials.idToken,
        account_id: credentials.accountId,
      },
    })
  )
}

export async function startOpenSweOAuthSession(modulePath, storagePath) {
  const { OpenAiOAuthManager, accountIdFromTokens } = require(modulePath)
  const manager = new OpenAiOAuthManager({
    storagePath,
    encryptString: (value) => updateLocalCredentials(storagePath, value),
    decryptString: () => JSON.stringify(readLocalCredentials(storagePath)),
  })
  if (!manager.status().signedIn) {
    throw new Error("No existing local OpenAI login was found")
  }
  const accountId = accountIdFromTokens(manager.credentials)
  if (!accountId) throw new Error("The local OpenAI login has no account ID")
  manager.credentials.accountId = accountId
  await manager.startBroker()
  return manager
}
