import { describe, expect, it } from "vitest"

import {
  orderByRecentUse,
  pickComposerRepo,
  pickComposerWorkspace,
} from "./composerWorkspace"

const base = {
  override: null,
  repoWorkspace: null,
  userDefault: null,
  instanceDefault: "default",
  workspaces: [{ slug: "default" }, { slug: "oss" }],
}

describe("pickComposerWorkspace", () => {
  it("prefers the user's default over the instance default when no repository decides", () => {
    expect(pickComposerWorkspace({ ...base, userDefault: "oss" })).toBe("oss")
    expect(pickComposerWorkspace(base)).toBe("default")
  })

  it("lets the repository's owner outrank the user's default", () => {
    expect(
      pickComposerWorkspace({
        ...base,
        repoWorkspace: "default",
        userDefault: "oss",
      })
    ).toBe("default")
  })

  it("keeps an explicit pick", () => {
    expect(
      pickComposerWorkspace({
        ...base,
        override: "oss",
        repoWorkspace: "default",
      })
    ).toBe("oss")
  })

  it("ignores a default that names no listed workspace", () => {
    expect(pickComposerWorkspace({ ...base, userDefault: "gone" })).toBe(
      "default"
    )
    expect(
      pickComposerWorkspace({
        ...base,
        userDefault: "gone",
        workspaces: [{ slug: "oss" }],
      })
    ).toBeNull()
  })
})

describe("pickComposerRepo", () => {
  const offered = [{ full_name: "acme/oss" }, { full_name: "acme/docs" }]

  it("keeps an explicit pick, including an explicit none", () => {
    const defaults = { userDefault: "acme/oss", workspaceDefault: "acme/oss" }
    expect(
      pickComposerRepo({ ...defaults, override: "acme/docs", offered })
    ).toBe("acme/docs")
    expect(
      pickComposerRepo({ ...defaults, override: null, offered })
    ).toBeNull()
  })

  it("prefers the user's default when offered, else the workspace's, else none", () => {
    expect(
      pickComposerRepo({
        override: undefined,
        userDefault: "ACME/docs",
        workspaceDefault: "acme/oss",
        offered,
      })
    ).toBe("acme/docs")
    expect(
      pickComposerRepo({
        override: undefined,
        userDefault: "acme/tools",
        workspaceDefault: "acme/oss",
        offered,
      })
    ).toBe("acme/oss")
    expect(
      pickComposerRepo({
        override: undefined,
        userDefault: "acme/tools",
        workspaceDefault: null,
        offered,
      })
    ).toBeNull()
  })
})

describe("orderByRecentUse", () => {
  it("lists repositories with threads first, newest activity first", () => {
    const offered = [
      { full_name: "acme/alpha" },
      { full_name: "acme/beta" },
      { full_name: "acme/gamma" },
      { full_name: "acme/delta" },
    ]
    const recent = [
      { repoFullName: "acme/gamma", updatedAt: 10 },
      { repoFullName: "ACME/Delta", updatedAt: 20 },
    ]

    expect(
      orderByRecentUse(offered, recent).map((repo) => repo.full_name)
    ).toEqual(["acme/delta", "acme/gamma", "acme/alpha", "acme/beta"])
  })
})
