# Ghost Browser MCP

Ghost Browser exposes a Streamable HTTP MCP endpoint at `/mcp`. It accepts the same
`Authorization: Bearer <key>` credential as the browser API. For the mavicpro-fan workspace the
endpoint is `https://ghost-browser.mavicpro-fan.my-app.engineer/mcp`. The server does not yet
provide MCP OAuth or separately scoped/revocable MCP credentials. An API key also authorizes other
Ghost Browser API operations: give it only to a client you trust. The authenticated owner can find
the existing keys under **Settings → Account → MCP setup** in the Ghost Browser web console;
never commit a key to a repository. Setup uses the current instance's host and reveals its key
only when requested. It no longer floats over the bottom navigation.

The Docker build compiles the shared Kotlin/Wasm console from the release commit, so Settings
changes ship with the server. The installed watcher's `gb-sync-ben.sh` entry point now delegates
to `gb-sync-all.js`: it discovers installed platform browsers and hosted user clusters, updates
idle browsers, and retries busy or unreachable instances on later cycles. It can recover an
unavailable instance when all its reported containers are blocked on image pulls.

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
`browser_click`, `browser_type`, `browser_scroll`, `browser_read`, `browser_extract_product`, and `browser_screenshot` operate
on that session; `browser_list` lists your sessions and `browser_close` releases one. Analyze before
using numbered click or type. Click and type can perform real actions on websites, and page content
is untrusted. The existing browser API enforces ownership, session limits and URL checks. Sessions
still expire under the browser's existing idle and maximum-lifetime limits.

## Product A webshop drafts

Connect both Ghost Browser and Product A's merchant MCP to the same assistant. Open an AliExpress
product page in Ghost Browser, then call `browser_extract_product` on that session. It returns the
source URL, title, description, images, any structured price/currency/SKU, and warnings for missing
facts. This is read-only and does not save or publish anything. A login or challenge page returns no
product data; complete sign-in in the browser before trying again.

After reviewing the facts, use Product A's `list_shops` and `create_product_draft` for the selected
shop. Pass the original AliExpress URL as `data.originalUrl`; Product A stores it with the draft.
Set a real shop-currency retail price, a unique SKU and stock quantity based on verified facts.
AliExpress prices, variants, availability, shipping and fulfillment must be checked separately.
Product A's normal publication approval applies before the product goes live. Neither connector
places supplier orders or sets up automatic fulfillment.
