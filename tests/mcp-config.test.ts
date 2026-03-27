import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolveProfile, buildMcpConfig, writeMcpConfigFile } from "../src/mcp-config.js";
import type { ProjectConfig } from "../src/config.js";

// ---------------------------------------------------------------------------
// resolveProfile
// ---------------------------------------------------------------------------

describe("resolveProfile", () => {
  it("resolves a simple profile", () => {
    const profiles = {
      base: {
        servers: {
          qmd: { command: "qmd", args: ["serve", "--stdio"] },
        },
      },
    };

    const servers = resolveProfile("base", profiles);
    expect(servers).toEqual({
      qmd: { command: "qmd", args: ["serve", "--stdio"] },
    });
  });

  it("resolves profile with extends", () => {
    const profiles = {
      base: {
        servers: {
          qmd: { command: "qmd", args: ["serve", "--stdio"] },
        },
      },
      design: {
        extends: "base",
        servers: {
          figma: { command: "npx", args: ["-y", "figma-console-mcp"] },
        },
      },
    };

    const servers = resolveProfile("design", profiles);
    expect(Object.keys(servers)).toEqual(
      expect.arrayContaining(["qmd", "figma"]),
    );
    expect(servers.qmd.command).toBe("qmd");
    expect(servers.figma.command).toBe("npx");
  });

  it("child overrides parent on name collision", () => {
    const profiles = {
      base: {
        servers: {
          qmd: { command: "qmd", args: ["v1"] },
        },
      },
      custom: {
        extends: "base",
        servers: {
          qmd: { command: "qmd", args: ["v2"] },
        },
      },
    };

    const servers = resolveProfile("custom", profiles);
    expect(servers.qmd.args).toEqual(["v2"]);
  });

  it("supports multi-level inheritance", () => {
    const profiles = {
      root: {
        servers: { a: { command: "a" } },
      },
      mid: {
        extends: "root",
        servers: { b: { command: "b" } },
      },
      leaf: {
        extends: "mid",
        servers: { c: { command: "c" } },
      },
    };

    const servers = resolveProfile("leaf", profiles);
    expect(Object.keys(servers).sort()).toEqual(["a", "b", "c"]);
  });

  it("throws on circular inheritance", () => {
    const profiles = {
      a: { extends: "b" },
      b: { extends: "a" },
    };

    expect(() => resolveProfile("a", profiles)).toThrow(/Circular/);
  });

  it("throws for missing profile", () => {
    expect(() => resolveProfile("ghost", {})).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// buildMcpConfig
// ---------------------------------------------------------------------------

describe("buildMcpConfig", () => {
  it("builds valid MCP config JSON structure", () => {
    const config: ProjectConfig = {
      mcp_profiles: {
        base: {
          servers: {
            qmd: { command: "qmd", args: ["serve", "--stdio"] },
          },
        },
      },
    };

    const result = buildMcpConfig("base", config);
    expect(result.mcpServers).toBeDefined();
    expect(result.mcpServers.qmd).toEqual({
      command: "qmd",
      args: ["serve", "--stdio"],
    });
  });

  it("omits empty args and env", () => {
    const config: ProjectConfig = {
      mcp_profiles: {
        minimal: {
          servers: {
            simple: { command: "simple" },
          },
        },
      },
    };

    const result = buildMcpConfig("minimal", config);
    expect(result.mcpServers.simple).toEqual({ command: "simple" });
    expect("args" in result.mcpServers.simple).toBe(false);
    expect("env" in result.mcpServers.simple).toBe(false);
  });

  it("includes env when provided", () => {
    const config: ProjectConfig = {
      mcp_profiles: {
        withenv: {
          servers: {
            svc: { command: "svc", env: { API_KEY: "123" } },
          },
        },
      },
    };

    const result = buildMcpConfig("withenv", config);
    expect(result.mcpServers.svc.env).toEqual({ API_KEY: "123" });
  });
});

// ---------------------------------------------------------------------------
// writeMcpConfigFile
// ---------------------------------------------------------------------------

describe("writeMcpConfigFile", () => {
  it("writes a valid JSON file and returns its path", async () => {
    const config: ProjectConfig = {
      mcp_profiles: {
        test: {
          servers: {
            qmd: { command: "qmd", args: ["serve"] },
          },
        },
      },
    };

    const path = await writeMcpConfigFile("test", config);
    expect(path).toBeDefined();
    expect(path!).toContain("cccp-mcp-");

    const content = JSON.parse(await readFile(path!, "utf-8"));
    expect(content.mcpServers.qmd.command).toBe("qmd");
  });

  it("returns undefined when no profile specified and no default", async () => {
    const result = await writeMcpConfigFile(undefined, {});
    expect(result).toBeUndefined();
  });

  it("uses default_mcp_profile when no explicit profile", async () => {
    const config: ProjectConfig = {
      default_mcp_profile: "base",
      mcp_profiles: {
        base: {
          servers: {
            qmd: { command: "qmd" },
          },
        },
      },
    };

    const path = await writeMcpConfigFile(undefined, config);
    expect(path).toBeDefined();
  });

  it("throws for explicitly requested missing profile", async () => {
    await expect(
      writeMcpConfigFile("ghost", { mcp_profiles: {} }),
    ).rejects.toThrow(/not found/);
  });
});
