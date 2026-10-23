'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, safeStorage } = require('electron');

const DEFAULT_SETTINGS = {
  refreshMinutes: 15,
  daysAhead: 14,
  notifyMinutes: 10,
  opacity: 0.92,
  placement: 'desktop', // 'desktop' 바탕화면에 고정 | 'normal' 일반 창 | 'top' 항상 위
  locked: false,
  launchAtLogin: false,
  expanded: false, // 크게 보기 상태
  bounds: null, // 기본 크기일 때의 창 위치·크기
  expandedBounds: null, // 크게 보기일 때의 창 위치·크기
};

function filePath(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

// 임시 파일에 쓴 뒤 교체해서, 저장 중 종료돼도 설정 파일이 깨지지 않게 한다.
function writeJson(name, value) {
  const target = filePath(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, target);
}

function load() {
  const raw = readJson('config.json', {});
  const { alwaysOnTop, ...saved } = raw.settings || {};
  // 이전 버전의 alwaysOnTop 설정을 창 배치(placement)로 옮긴다.
  if (alwaysOnTop && !saved.placement) saved.placement = 'top';
  return {
    sources: Array.isArray(raw.sources) ? raw.sources : [],
    settings: { ...DEFAULT_SETTINGS, ...saved },
  };
}

function save(config) {
  writeJson('config.json', config);
}

// ICS 비공개 주소와 CalDAV 비밀번호는 Windows DPAPI(safeStorage)로 암호화해 저장한다.
function encryptSecret(plain) {
  if (safeStorage.isEncryptionAvailable()) {
    return { enc: true, data: safeStorage.encryptString(plain).toString('base64') };
  }
  return { enc: false, data: Buffer.from(plain, 'utf8').toString('base64') };
}

function decryptSecret(secret) {
  if (!secret || !secret.data) return '';
  const buf = Buffer.from(secret.data, 'base64');
  return secret.enc ? safeStorage.decryptString(buf) : buf.toString('utf8');
}

// 렌더러에는 비밀값을 보내지 않고 저장 여부만 알린다.
function publicSource(source) {
  const { secret, ...rest } = source;
  return { ...rest, hasSecret: Boolean(secret) };
}

module.exports = {
  DEFAULT_SETTINGS,
  load,
  save,
  readJson,
  writeJson,
  encryptSecret,
  decryptSecret,
  publicSource,
};
