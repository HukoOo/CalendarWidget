'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_e, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('calendarApi', {
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('refresh'),
  openSettings: () => ipcRenderer.invoke('settings:open'),
  setExpanded: (on) => ipcRenderer.invoke('widget:expand', on),
  getBounds: () => ipcRenderer.invoke('widget:get-bounds'),
  setBounds: (bounds) => ipcRenderer.send('widget:set-bounds', bounds),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (config) => ipcRenderer.invoke('config:save', config),
  testSource: (source) => ipcRenderer.invoke('source:test', source),
  onState: (callback) => subscribe('state:update', callback),
  onSettings: (callback) => subscribe('settings:update', callback),
});
