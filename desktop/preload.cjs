const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linksunderDesktop', {
  chooseReportDirectory: () => ipcRenderer.invoke('linksunder:choose-report-directory'),
  openReportDirectory: () => ipcRenderer.invoke('linksunder:open-report-directory'),
  minimize: () => ipcRenderer.send('linksunder:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('linksunder:toggle-maximize'),
  isMaximized: () => ipcRenderer.invoke('linksunder:is-maximized'),
  close: () => ipcRenderer.send('linksunder:close'),
  onWindowState: (listener) => {
    const handle = (_event, maximized) => listener(maximized);
    ipcRenderer.on('linksunder:window-state', handle);
    return () => ipcRenderer.removeListener('linksunder:window-state', handle);
  },
});
