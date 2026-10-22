# Ghost Browser MCP

Ghost Browser exposes a Streamable HTTP MCP endpoint at `/mcp`. It accepts the same
`Authorization: Bearer <key>` credential as the browser API. For the mavicpro-fan workspace the
endpoint is `https://ghost-browser.mavicpro-fan.my-app.engineer/mcp`. The server does not yet
provide MCP OAuth or separately scoped/revocable MCP credentials. An API key also authorizes other
Ghost Browser API operations: give it only to a client you trust. The authenticated owner can find
the existing keys in the Ghost Browser console; never commit a key to a repository.

## Codex

Set `GHOST_BROWSER_KEY` in the environment that launches Codex, then add to your Codex config:

```toml
[mcp_servers.ghost_browser]
url = "https://ghost-browser.mavicpro-fan.my-app.engineer/mcp"
bearer_token_env_var = "GHOST_BROWSER_KEY"
tool_timeout_sec = 90
```

See the [Codex MCP documentation](https://developers.openai.com/codex/mcp) for configuration.
Restart or start a new Codex session after configuring it.

## Claude Code

Configure a remote HTTP server with the endpoint above and an `Authorization` header containing
`Bearer ` followed by your key. Use a private configuration or environment variable, not a checked-in
project file containing the secret. This endpoint does not support OAuth login.

## Tools

`browser_open` starts an isolated session and returns an ID. `browser_navigate`, `browser_analyze`,
`browser_click`, `browser_type`, `browser_scroll`, `browser_read`, and `browser_screenshot` operate
on that session; `browser_list` lists your sessions and `browser_close` releases one. Analyze before
using numbered click or type. Click and type can perform real actions on websites, and page content
is untrusted. The existing browser API enforces ownership, session limits and URL checks. Sessions
still expire under the browser's existing idle and maximum-lifetime limits.
