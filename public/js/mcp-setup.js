(function () {
  const endpointInput = document.getElementById('mcpEndpoint');
  if (!endpointInput) return;

  const endpoint = new URL('/mcp', location.origin).href;
  const codex = '[mcp_servers.ghost_browser]\n'
    + 'url = "' + endpoint + '"\n'
    + 'bearer_token_env_var = "GHOST_BROWSER_KEY"\n'
    + 'tool_timeout_sec = 90';
  const claude = 'claude mcp add --transport http --scope user '
    + '--header "Authorization: Bearer YOUR_GHOST_BROWSER_KEY" '
    + 'ghost-browser "' + endpoint + '"';

  endpointInput.value = endpoint;
  document.getElementById('mcpCodexConfig').textContent = codex;
  document.getElementById('mcpClaudeCommand').textContent = claude;

  const status = document.getElementById('mcpSetupMsg');
  for (const [id, value, label] of [
    ['mcpCopyUrl', endpoint, 'Server URL'],
    ['mcpCopyCodex', codex, 'Codex config'],
    ['mcpCopyClaude', claude, 'Claude command'],
  ]) {
    document.getElementById(id).addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        status.textContent = label + ' copied';
        status.className = 'smsg ok';
      } catch {
        status.textContent = 'Could not copy. Select and copy the text above instead.';
        status.className = 'smsg err';
      }
    });
  }
})();
