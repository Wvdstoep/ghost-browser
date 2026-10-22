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

  const reveal = document.getElementById('mcpRevealKey');
  if (reveal) reveal.addEventListener('click', async () => {
    const box = document.getElementById('mcpKeyBox');
    try {
      const response = await fetch('/api/auth/key', { credentials: 'same-origin' });
      if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to Ghost Browser first.' : 'Could not load API keys.');
      const data = await response.json();
      box.textContent = (data.keys || []).map(item => item.key).join('\n') || 'No API key configured.';
    } catch (error) { box.textContent = error.message; }
    box.classList.remove('hide');
  });
})();
