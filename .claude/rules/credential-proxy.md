# Credential Proxy (OneCLI)

- API keys, OAuth tokens, and auth credentials are managed by the OneCLI Agent Vault.
- The vault injects secrets into containers at request time; no raw keys are ever passed directly.
- Do not add credential-passing logic to container startup or mount arguments.
- To inspect or rotate credentials: `onecli --help`.
- This is a Claude Code convention; Codex does not need awareness of OneCLI.
