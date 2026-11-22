// Prevent content from opening untrusted windows without changing app-created windows.
function installPopupBlocker(app) {
  app.on('web-contents-created', (_, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });
}

module.exports = { installPopupBlocker };
