'use strict';
const fs = require('fs');
const path = require('path');
function prepareConsole(root = path.join(__dirname, '..', 'public')) {
  if (!fs.existsSync(path.join(root, 'console', 'gbweb.js'))) return false;
  const loader = fs.readFileSync(path.join(root, 'compose-index.html'));
  fs.writeFileSync(path.join(root, 'index.html'), loader);
  fs.writeFileSync(path.join(root, 'console', 'index.html'), loader);
  return true;
}
if (require.main === module) prepareConsole();
module.exports = { prepareConsole };
