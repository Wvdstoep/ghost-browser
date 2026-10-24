'use strict';

// Some sites create and remove their file input in the upload click handler.
// Capture the chooser before that click so upload_file can still supply bytes.
const pending = new WeakMap();
const attached = new WeakSet();

function captureFileChoosers(context) {
  const attach = (page) => {
    if (attached.has(page)) return;
    attached.add(page);
    page.on('filechooser', (chooser) => pending.set(page, chooser));
    page.on('close', () => pending.delete(page));
  };
  context.pages().forEach(attach);
  context.on('page', attach);
}

function takeFileChooser(page) {
  const chooser = pending.get(page);
  pending.delete(page);
  return chooser;
}

module.exports = { captureFileChoosers, takeFileChooser };
