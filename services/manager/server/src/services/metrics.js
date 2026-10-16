'use strict';

const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const log = require('../logger');

const execFileAsync = promisify(execFile);

/**
 * 이 장비의 CPU · RAM · 저장소 · 네트워크 사용량.
 *
 * /proc 을 직접 읽는다 (의존성 없음, 리눅스 전용 — 이 저장소가 세우는 장비는 모두 리눅스다).
 * CPU 와 네트워크는 "누적 카운터" 라서 두 시점의 차이로만 비율이 나온다. 그래서 요청이 올 때
 * 재는 대신 sampler 가 SAMPLE_MS 마다 재서 최근 HISTORY_LEN 개를 메모리에 들고 있다 —
 * 요청은 그것을 읽기만 하므로 여러 사람이 열어도 /proc 읽기 횟수가 늘지 않고, 그래프의
 * 지난 몇 분도 공짜로 얻는다. 재기동하면 비워진다 (영속이 필요한 값이 아니다).
 */

const SAMPLE_MS = 5000;
const HISTORY_LEN = 120; // 5초 × 120 = 최근 10분
const DISK_TTL_MS = 30000;
const UNIT_TTL_MS = 10000;

// 대시보드가 보는 systemd 유닛. 설치되지 않은 것(LoadState=not-found)은 조용히 뺀다.
const WATCHED_UNITS = ['nginx', 'mariadb'];

// 디스크로 보지 않는 파일시스템. 용량이 의미 없거나 항상 100% 인 것들이다.
const SKIP_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'efivarfs', 'ramfs', 'proc', 'sysfs']);

// 물리 NIC 이 아닌 것. 컨테이너 쪽 가상 장치는 합계를 부풀리므로 뺀다.
const VIRTUAL_IF = /^(lo|veth|docker|br-|virbr|cni|flannel|cali)/;

const state = {
  timer: null,
  prevCpu: null,
  prevNet: null,
  prevAt: 0,
  latest: null,
  history: [],
  disks: { at: 0, value: [] },
  units: { at: 0, value: [], prev: new Map() },
};

// --- /proc 파서 ---

function readCpuTimes() {
  const lines = fs.readFileSync('/proc/stat', 'utf8').split('\n');
  const out = {};
  for (const line of lines) {
    const m = line.match(/^(cpu\d*)\s+(.*)$/);
    if (!m) continue;
    const n = m[2].trim().split(/\s+/).map(Number);
    const total = n.slice(0, 8).reduce((a, b) => a + b, 0); // guest 는 user 에 이미 들어 있다
    const idle = (n[3] || 0) + (n[4] || 0); // idle + iowait
    out[m[1]] = { total, idle };
  }
  return out;
}

function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const dTotal = cur.total - prev.total;
  const dIdle = cur.idle - prev.idle;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, ((dTotal - dIdle) / dTotal) * 100));
}

function readMemory() {
  const info = {};
  for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) info[m[1]] = Number(m[2]) * 1024;
  }
  const total = info.MemTotal || 0;
  // MemAvailable 이 없는 아주 오래된 커널은 쓰지 않는다 — free+buffers+cached 로 대신한다.
  const available = info.MemAvailable ?? (info.MemFree || 0) + (info.Buffers || 0) + (info.Cached || 0);
  const swapTotal = info.SwapTotal || 0;
  return {
    totalBytes: total,
    usedBytes: Math.max(0, total - available),
    availableBytes: available,
    cachedBytes: (info.Cached || 0) + (info.Buffers || 0),
    swapTotalBytes: swapTotal,
    swapUsedBytes: Math.max(0, swapTotal - (info.SwapFree || 0)),
  };
}

function readNet() {
  const out = {};
  const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    if (VIRTUAL_IF.test(name)) continue;
    const f = line.slice(idx + 1).trim().split(/\s+/).map(Number);
    out[name] = { rx: f[0] || 0, tx: f[8] || 0, rxErr: f[2] || 0, txErr: f[10] || 0 };
  }
  return out;
}

function ifaceState(name) {
  try {
    return fs.readFileSync(`/sys/class/net/${name}/operstate`, 'utf8').trim();
  } catch {
    return null;
  }
}

function ifaceSpeedMbps(name) {
  try {
    const v = Number(fs.readFileSync(`/sys/class/net/${name}/speed`, 'utf8').trim());
    return v > 0 ? v : null; // 끊긴 링크나 무선은 -1
  } catch {
    return null;
  }
}

// --- 느리게 변하는 것: 디스크, systemd 유닛 ---

async function readDisks() {
  if (Date.now() - state.disks.at < DISK_TTL_MS) return state.disks.value;
  try {
    const { stdout } = await execFileAsync('df', ['-PT', '-B1'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const seen = new Set();
    const disks = [];
    for (const line of stdout.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 7) continue;
      const [device, fsType, size, used, avail, , ...mount] = f;
      if (SKIP_FS.has(fsType) || !device.startsWith('/')) continue;
      if (seen.has(device)) continue; // bind mount 로 같은 장치가 여러 번 나온다
      seen.add(device);
      const total = Number(size);
      if (!total) continue;
      disks.push({
        device,
        fsType,
        mount: mount.join(' '),
        totalBytes: total,
        usedBytes: Number(used),
        availBytes: Number(avail),
        percent: (Number(used) / (Number(used) + Number(avail))) * 100,
      });
    }
    state.disks = { at: Date.now(), value: disks };
  } catch (err) {
    log.warn(`df failed: ${err.message}`);
    state.disks.at = Date.now(); // 실패해도 곧바로 다시 부르지 않는다
  }
  return state.disks.value;
}

const UNSET = 18446744073709551615n;

async function readUnits() {
  if (Date.now() - state.units.at < UNIT_TTL_MS) return state.units.value;
  const now = Date.now();
  try {
    const { stdout } = await execFileAsync(
      'systemctl',
      ['show', ...WATCHED_UNITS.map((u) => `${u}.service`), '--property=Id,LoadState,ActiveState,MainPID,MemoryCurrent,CPUUsageNSec'],
      { timeout: 5000 },
    );
    const units = [];
    const prev = state.units.prev;
    const next = new Map();

    for (const block of stdout.split('\n\n')) {
      const p = {};
      for (const line of block.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) p[line.slice(0, idx)] = line.slice(idx + 1);
      }
      if (!p.Id || p.LoadState === 'not-found') continue;

      const name = p.Id.replace(/\.service$/, '');
      const mem = /^\d+$/.test(p.MemoryCurrent || '') && BigInt(p.MemoryCurrent) !== UNSET ? Number(p.MemoryCurrent) : null;
      const cpuNs = /^\d+$/.test(p.CPUUsageNSec || '') && BigInt(p.CPUUsageNSec) !== UNSET ? Number(p.CPUUsageNSec) : null;

      let cpu = null;
      const before = prev.get(name);
      if (cpuNs != null && before && now > before.at && cpuNs >= before.ns) {
        cpu = ((cpuNs - before.ns) / ((now - before.at) * 1e6)) * 100; // 코어 하나를 100% 로 본다 (pm2/top 과 같은 기준)
      }
      if (cpuNs != null) next.set(name, { ns: cpuNs, at: now });

      units.push({
        name,
        active: p.ActiveState === 'active',
        state: p.ActiveState || 'unknown',
        pid: p.MainPID && p.MainPID !== '0' ? Number(p.MainPID) : null,
        cpu,
        memoryBytes: mem,
      });
    }
    state.units.prev = next;
    state.units.value = units;
  } catch (err) {
    log.warn(`systemctl show failed: ${err.message}`);
  }
  state.units.at = now;
  return state.units.value;
}

// --- sampler ---

async function sample() {
  const now = Date.now();
  try {
    const cpuNow = readCpuTimes();
    const netNow = readNet();
    const memory = readMemory();
    const dt = state.prevAt ? (now - state.prevAt) / 1000 : 0;

    const cores = Object.keys(cpuNow)
      .filter((k) => k !== 'cpu')
      .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
      .map((k) => cpuPercent(state.prevCpu?.[k], cpuNow[k]));
    const cpuTotal = cpuPercent(state.prevCpu?.cpu, cpuNow.cpu);

    const interfaces = Object.keys(netNow)
      .sort()
      .map((name) => {
        const before = state.prevNet?.[name];
        const rate = (key) => (before && dt > 0 ? Math.max(0, (netNow[name][key] - before[key]) / dt) : null);
        return {
          name,
          state: ifaceState(name),
          speedMbps: ifaceSpeedMbps(name),
          rxBytesPerSec: rate('rx'),
          txBytesPerSec: rate('tx'),
          rxTotalBytes: netNow[name].rx,
          txTotalBytes: netNow[name].tx,
          errors: netNow[name].rxErr + netNow[name].txErr,
        };
      });

    const sum = (key) => {
      const vals = interfaces.map((i) => i[key]).filter((v) => v != null);
      return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
    };

    const [disks, units] = await Promise.all([readDisks(), readUnits()]);

    const snapshot = {
      at: new Date(now).toISOString(),
      cpu: {
        percent: cpuTotal,
        cores,
        coreCount: os.cpus().length,
        model: os.cpus()[0]?.model || null,
        loadAvg: os.loadavg(),
      },
      memory,
      disks,
      network: {
        rxBytesPerSec: sum('rxBytesPerSec'),
        txBytesPerSec: sum('txBytesPerSec'),
        rxTotalBytes: sum('rxTotalBytes'),
        txTotalBytes: sum('txTotalBytes'),
        interfaces,
      },
      systemd: units,
      uptimeSec: Math.floor(os.uptime()),
    };

    state.prevCpu = cpuNow;
    state.prevNet = netNow;
    state.prevAt = now;
    state.latest = snapshot;

    state.history.push({
      t: now,
      cpu: cpuTotal,
      mem: memory.totalBytes ? (memory.usedBytes / memory.totalBytes) * 100 : null,
      rx: snapshot.network.rxBytesPerSec,
      tx: snapshot.network.txBytesPerSec,
    });
    if (state.history.length > HISTORY_LEN) state.history.shift();
  } catch (err) {
    // /proc 이 없는 장비(리눅스가 아님)에서는 첫 표본부터 실패한다 — 화면이 "측정 불가" 를 보인다.
    log.warn(`metrics sample failed: ${err.message}`);
    state.latest = null;
  }
}

function start() {
  if (state.timer) return;
  sample(); // 첫 표본은 기준점이라 비율은 비어 있다. 두 번째부터 값이 찬다.
  state.timer = setInterval(sample, SAMPLE_MS);
  state.timer.unref();
}

/** 가장 최근 표본과 지난 기록. 아직 표본이 없으면 null. */
function snapshot() {
  if (!state.latest) return null;
  return { ...state.latest, sampleMs: SAMPLE_MS, history: state.history };
}

module.exports = { start, snapshot };
