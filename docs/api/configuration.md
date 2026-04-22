# Configuration

The `cccp.yaml` file at the project root configures agent resolution, MCP server profiles, artifact output, and agent subprocess behavior.

**Source files:**
- [`src/config.ts`](../../src/config.ts) -- Zod schema and loader
- [`src/mcp/mcp-config.ts`](../../src/mcp/mcp-config.ts) -- MCP profile resolution and config file generation

## Schema

```yaml
# cccp.yaml — project configuration

# Directories to search for agent definitions (in priority order).
agent_paths:
  - ./agents
  - ./.claude/agents

# Named MCP server profiles.
mcp_profiles:
  base:
    servers:
      qmd:
        command: qmd
        args: [serve, --stdio]
  design:
    extends: base
    servers:
      figma:
        command: npx
        args: [-y, figma-console-mcp]

# Default artifact output directory pattern.
# Supports {project} and {pipeline_name} variables.
artifact_dir: docs/projects/{project}/{pipeline_name}

# Default MCP profile applied when a stage doesn't specify one.
default_mcp_profile: base

# Claude config directory for agent subprocesses.
claude_config_dir: /Users/me/.claude-profile

# Permission mode for agent subprocesses.
permission_mode: bypassPermissions
```

## Fields

### `agent_paths`

**Type:** `string[]` (optional)

Ordered list of directories to search for agent definitions. Paths are resolved relative to the `cccp.yaml` file's directory. These paths are appended to the built-in search paths:

1. `<pipeline-yaml-dir>/agents/`
2. `<project-dir>/.claude/agents/`
3. `<project-dir>/agents/`
4. Paths from `agent_paths` (in order)

See [Agent Authoring](../guides/agent-authoring.md) for agent resolution details.

### `mcp_profiles`

**Type:** `Record<string, McpProfile>` (optional)

Named MCP server profiles. Each profile defines a set of MCP servers that an agent will have access to. Profiles support single inheritance via `extends`.

```typescript
// Zod schema (from src/config.ts)
const McpServerSchema = z.object({
  command: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

const McpProfileSchema = z.object({
  extends: z.string().optional(),
  servers: z.record(McpServerSchema).optional(),
});
```

When a stage specifies `mcp_profile: design`, the resolved profile's servers are written to a temporary JSON file and passed to Claude via `--mcp-config <path> --strict-mcp-config`. The `--strict-mcp-config` flag ensures the agent only has access to the servers in its profile.

**Agents are fully isolated from the project's `.mcp.json`.** MCP servers registered in `.mcp.json` (for example, the `cccp` server you register so Claude Code can approve gates) are **not** inherited by pipeline agents. Pipeline agents see only the servers defined in their resolved `mcp_profile` — nothing else. If an agent needs a server, add it to a profile.

### `artifact_dir`

**Type:** `string` (optional)

Default artifact output directory pattern. Supports `{project}` and `{pipeline_name}` variable interpolation.

**Default:** `docs/projects/{project}/{pipeline_name}`

This is overridden by the `--artifact-dir` CLI flag.

### `default_mcp_profile`

**Type:** `string` (optional)

Default MCP profile name applied when a stage does not specify its own `mcp_profile`. If a stage has no `mcp_profile` and no default is set, agents run without any MCP servers.

**Opting a single agent out of the default:** there is no `mcp_profile: none` keyword. If you set `default_mcp_profile` but want one stage or agent to run with zero MCP servers, define an empty profile and reference it:

```yaml
mcp_profiles:
  none:
    servers: {}          # resolves to zero servers → no --mcp-config passed
  base:
    servers:
      qmd: { command: qmd, args: [serve, --stdio] }

default_mcp_profile: base
```

```yaml
- name: sandboxed-step
  type: agent
  agent: researcher
  mcp_profile: none       # overrides the default, runs with no MCP servers
```

### `claude_config_dir`

**Type:** `string` (optional)

Directory used as `CLAUDE_CONFIG_DIR` for agent subprocesses. Agents inherit authentication, settings, and plugins from this profile directory.

**Default:** Inherits `CLAUDE_CONFIG_DIR` from the environment, or `~/.claude`.

This is useful when you want pipeline agents to use a different Claude profile (with different permissions, settings, or authentication) than your interactive Claude Code session.

### `permission_mode`

**Type:** `"default" | "acceptEdits" | "bypassPermissions" | "auto"` (optional)

Permission mode passed to each agent subprocess via `--permission-mode`. Pipeline agents run non-interactively, so they need pre-granted permissions.

**Default:** `bypassPermissions`

| Mode | Description |
|------|-------------|
| `default` | Standard interactive permissions |
| `acceptEdits` | Auto-accept file edits, prompt for other tools |
| `bypassPermissions` | Skip all permission prompts |
| `auto` | Use the model's default permission behavior |

## MCP Profile Inheritance

Profiles support single inheritance via the `extends` field. Child profiles inherit all servers from the parent and can add or override servers.

### Example: inheritance chain

```yaml
mcp_profiles:
  base:
    servers:
      qmd:
        command: qmd
        args: [serve, --stdio]
      filesystem:
        command: npx
        args: [-y, "@anthropic/mcp-server-filesystem"]

  design:
    extends: base
    servers:
      figma:
        command: npx
        args: [-y, figma-console-mcp]

  design-plus:
    extends: design
    servers:
      storybook:
        command: npx
        args: [-y, storybook-mcp]
```

Resolution for `design-plus`:
1. Start with `design` (which extends `base`)
2. `base` has `qmd` and `filesystem`
3. `design` adds `figma`
4. `design-plus` adds `storybook`
5. Final servers: `qmd`, `filesystem`, `figma`, `storybook`

### Server override

A child can override a parent's server definition by using the same name:

```yaml
mcp_profiles:
  base:
    servers:
      search:
        command: basic-search
        args: [--stdio]

  advanced:
    extends: base
    servers:
      search:                    # Overrides base.search
        command: advanced-search
        args: [--stdio, --deep]
```

### Circular inheritance detection

The resolver tracks visited profiles and throws an error if a cycle is detected:

```
Error: Circular MCP profile inheritance: base → design → base
```

## Generated MCP Config File

When a profile is resolved, the output is a JSON file matching the format expected by `claude --mcp-config`:

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["serve", "--stdio"]
    },
    "figma": {
      "command": "npx",
      "args": ["-y", "figma-console-mcp"]
    }
  }
}
```

The file is written to a temp path (`cccp-mcp-<uuid>.json` in `os.tmpdir()`) and cleaned up by the OS.

If a profile resolves to zero servers, no config file is written and no `--mcp-config` flag is passed.

## Using Profiles in Pipelines

Profiles can be assigned at multiple levels:

```yaml
stages:
  - name: research
    type: agent
    agent: researcher
    mcp_profile: base              # Stage-level profile

  - name: review
    type: pge
    mcp_profile: base              # Shared fallback for planner + generator + evaluator
    planner:
      agent: architect
      mcp_profile: research        # Planner-specific profile (overrides stage)
    generator:
      agent: writer
      mcp_profile: design          # Generator-specific profile (overrides stage)
    evaluator:
      agent: reviewer
      # No mcp_profile -- falls back to stage-level "base"
    contract:
      deliverable: "{artifact_dir}/output.md"
      max_iterations: 3
```

Resolution order for PGE stages (highest priority wins):
1. Planner/generator/evaluator-specific `mcp_profile`
2. Stage-level `mcp_profile`
3. `default_mcp_profile` from `cccp.yaml`
4. None — no `--mcp-config` flag is passed and the agent has access to no MCP servers

## Related Documentation

- [Pipeline Authoring](../guides/pipeline-authoring.md) -- using `mcp_profile` in stage definitions
- [Agent Dispatch](../patterns/agent-dispatch.md) -- how `--mcp-config` and `--strict-mcp-config` are passed
- [Project Setup](../guides/project-setup.md) -- creating `cccp.yaml`
