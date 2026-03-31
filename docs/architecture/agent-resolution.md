# Agent Resolution & MCP Config

## Agent resolver (`src/agent-resolver.ts`)

### Resolution algorithm

Given an agent name (e.g., `"architect"`) and a list of search paths:

1. **Direct path detection**: If the name contains `/` or ends in `.md`, treat it as a relative/absolute path. Resolve against `projectDir`. Skip search.

2. **Search paths** (first match wins): For each directory in `searchPaths`:
   - Try flat file: `<dir>/<name>.md`
   - Try directory agent: `<dir>/<name>/agent.md`

3. **Operation resolution**: If `operation` is specified:
   - Agent must be directory-style (has `agent.md`)
   - Operation file: `<dir>/<name>/<operation>.md`
   - Both `agent.md` and `<operation>.md` must exist

### Search path construction (in `cli.ts`)

Order (first match wins):
1. `<pipeline-yaml-dir>/agents/` — agents co-located with the pipeline
2. `<project-dir>/.claude/agents/` — Claude Code agents directory
3. `<project-dir>/agents/` — project agents directory
4. Paths from `cccp.yaml` → `agent_paths` (already resolved to absolute)

### Prompt assembly

`loadAgentMarkdown()` in `src/prompt.ts`:
- Flat agent: reads the `.md` file as-is
- Directory agent + operation: concatenates `agent.md` + `\n\n---\n\n` + `<operation>.md`

The result is written to a temp file (`/tmp/cccp-agent-<uuid>.md`) and passed via `--system-prompt-file`.

## MCP config (`src/mcp/mcp-config.ts`)

### Profile resolution

Profiles defined in `cccp.yaml` support `extends` inheritance:

```yaml
mcp_profiles:
  base:
    servers:
      qmd: { command: qmd, args: [serve, --stdio] }
  design:
    extends: base
    servers:
      figma: { command: npx, args: [-y, figma-console-mcp] }
```

`resolveProfile("design", profiles)` returns `{ qmd: ..., figma: ... }`.

Circular inheritance is detected and throws.

### Config file generation

`writeMcpConfigFile(profileName, config)`:
1. Resolve the profile (with inheritance)
2. Build `{ mcpServers: { ... } }` JSON matching claude's `--mcp-config` format
3. Write to temp file, return path
4. Returns `undefined` if no profile specified and no default

### Per-agent isolation

Each agent dispatch can specify its own MCP profile. In PGE stages, planner, generator, and evaluator can have different profiles:

```yaml
planner:
  agent: architect
  mcp_profile: research    # gets qmd + google-workspace
generator:
  agent: implementer
  mcp_profile: design      # gets design tools
evaluator:
  agent: reviewer
  mcp_profile: base        # gets only qmd
```

The `--strict-mcp-config` flag ensures agents can only use the servers in their profile.
