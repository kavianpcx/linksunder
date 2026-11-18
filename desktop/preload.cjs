const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linksunderDesktop', {
  chooseReportDirectory: () => ipcRenderer.invoke('linksunder:choose-report-directory'),
  chooseGeolocationDatabase: (kind) => ipcRenderer.invoke('linksunder:choose-geolocation-database', kind),
  openGeolocationSignup: () => ipcRenderer.invoke('linksunder:open-geolocation-signup'),
  openReleasePage: () => ipcRenderer.invoke('linksunder:open-release-page'),
  getUpdateState: () => ipcRenderer.invoke('linksunder:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('linksunder:check-updates'),
  downloadUpdate: () => ipcRenderer.invoke('linksunder:download-update'),
  cancelUpdateDownload: () => ipcRenderer.invoke('linksunder:cancel-update-download'),
  installUpdate: () => ipcRenderer.invoke('linksunder:install-update'),
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
  onUpdateState: (listener) => {
    const handle = (_event, state) => listener(state);
    ipcRenderer.on('linksunder:update-state', handle);
    return () => ipcRenderer.removeListener('linksunder:update-state', handle);
  },
});
