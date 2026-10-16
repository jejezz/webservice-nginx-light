const fs = require('fs');
const path = require('path');
const { parseIni } = require('../nginx-conf');

/**
 * 서비스 폴더 하나의 선언(nginx-conf/*.ini · pm2-conf/*.ini) **전부**를 읽는다.
 *
 * 한 폴더가 서비스를 둘 이상 담을 수 있다 — 예를 들어 janus 폴더는 janus 와 janus-dashboard 를,
 * apartment-mgmt-server-node 는 huygens-server(service.ini · app.ini)와 web-cassini(cassini.ini ·
 * cassini.ini)를 담는다. 그래서 "service.ini · app.ini 한 쌍의 name 이 폴더 이름과 같다" 는 가정은
 * 서비스 추가 마법사가 만든 스켈레톤에만 맞고, 직접 clone 한 repo 에는 틀린다.
 *
 * 짝은 **이름**으로 맺는다: nginx 의 [service] name 과 pm2 의 [app] name 이 같으면 한 서비스다
 * (docs/guide/declarations.md). 읽기만 한다.
 */

function listIni(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.ini')).sort().map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

function readIni(file) {
  try {
    return parseIni(fs.readFileSync(file, 'utf8'));
  } catch {
    return { sections: {}, order: [] };
  }
}

/** nginx-conf/*.ini → [{ file, name, ports[], enabled, routes[{ key, location }] }] */
function readNginx(dir) {
  return listIni(path.join(dir, 'nginx-conf')).map((file) => {
    const { sections, order } = readIni(file);
    const svc = sections.service || {};
    const keys = order || Object.keys(sections);
    return {
      file: path.relative(path.dirname(dir), file),
      name: svc.name || null,
      ports: String(svc.ports || '').split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger),
      enabled: String(svc.enabled ?? 'true').toLowerCase() !== 'false',
      routes: keys
        .filter((k) => String(k).startsWith('route:'))
        .map((k) => ({ key: String(k).slice(6), location: String((sections[k] || {}).location || '').trim() })),
    };
  });
}

/** pm2-conf/*.ini → [{ file, name, cwd, script, interpreter, port }] */
function readPm2(dir) {
  return listIni(path.join(dir, 'pm2-conf')).map((file) => {
    const { sections } = readIni(file);
    const app = sections.app || {};
    const env = sections.env || {};
    return {
      file: path.relative(path.dirname(dir), file),
      name: app.name || null,
      cwd: app.cwd || '.',
      script: app.script || null,
      interpreter: app.interpreter || null,
      enabled: String(app.enabled ?? 'true').toLowerCase() !== 'false',
      port: env.PORT ? Number(env.PORT) : null,
    };
  });
}

/** 이름으로 짝을 맺는다. 짝이 없는 쪽은 한쪽만 채워진다. */
function pair(dir) {
  const nginx = readNginx(dir);
  const pm2 = readPm2(dir);
  const byName = new Map();
  for (const n of nginx) byName.set(n.name || `(이름 없음: ${n.file})`, { name: n.name, nginx: n, app: null });
  for (const a of pm2) {
    const key = a.name || `(이름 없음: ${a.file})`;
    const hit = byName.get(key);
    if (hit) hit.app = a;
    else byName.set(key, { name: a.name, nginx: null, app: a });
  }
  return { nginx, pm2, services: [...byName.values()] };
}

/** 이 폴더의 서비스들이 쓰는 포트(nginx ports 와 pm2 PORT). */
function portsOf(entry) {
  return [...new Set([...(entry.nginx ? entry.nginx.ports : []), ...(entry.app && entry.app.port ? [entry.app.port] : [])])];
}

module.exports = { listIni, readNginx, readPm2, pair, portsOf };
