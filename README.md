# pi-cc

This Pi extension allows you to use your Claude subscription in Pi by
routing requests through the official CLI.

## Environment variables

Set these in the environment Pi runs in, or as provider-scoped settings for
the `claude-code` provider.

| Variable | Effect |
| --- | --- |
| `PI_CLAUDE_CODE_COMMAND` | Claude Code executable, as a name on `PATH` or a path. Defaults to `claude`. On Windows it can be a `.cmd`, `.bat` or `.ps1` file. |
| `PI_CLAUDE_CODE_CONFIG_DIR` | Claude Code configuration directory for the processes this extension starts. It overrides `CLAUDE_CONFIG_DIR`. Use it to keep a separate Claude Code login for Pi. |
| `CLAUDE_CONFIG_DIR` | Claude Code's own configuration directory variable. It is passed through when `PI_CLAUDE_CODE_CONFIG_DIR` is unset. |
| `PI_CLAUDE_CODE_POWERSHELL` | PowerShell host used to run a `.ps1` command. Defaults to `pwsh`, then `powershell`. |
| `PI_CLAUDE_CODE_ALLOW_USAGE_CREDITS` | Set to `1` to keep going when Claude Code reports a turn was charged to usage credits instead of plan limits. When unset, that turn fails and Pi stops. `0`, `false`, `no` and `off` count as unset. |

### Variables that stop requests

These would change how Claude Code authenticates or where it sends requests.
If any of them is set, each request fails with an error that names it.

- `ANTHROPIC_AUTH_TOKEN`
- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_FOUNDRY_API_KEY`
- `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY`, when set to a value other than `0`, `false`, `no` or `off`

`ANTHROPIC_API_KEY` does not stop requests. The extension removes it from
Claude Code's environment so Claude Code uses your subscription login.
