const path = require('path');
const config = require('../config');
const { loadRoutes } = require('../nginx-conf');

/**
 * light 판에는 통화 시스템(Kamailio · Janus · coturn)이 없어 UDP 미디어 대역과 컨트롤
 * 소켓이 없다. 서비스를 붙여 그런 포트가 생기면 아래 두 함수에 행을 추가한다.
 *
 * 행의 모양 (화면이 읽는다):
 *   rtp      { role, service, settingKey, value, protocol, forwarded, note? }
 *   control  { name, value, protocol, forwarded, note?, service?, settingKey? }
 *
 * value 를 서비스의 settings.ini 에서 읽으려면 저장소 공용 구현을 쓴다:
 *   const settingsLib = require(path.join(config.repoRoot, 'lib', 'settings'));
 *   settingsLib.state(path.join(SERVICES_DIR, '<서비스 폴더>')).values[key]
 * 스키마를 여기서 새로 파싱하지 않는 이유는 docs/guide/contracts.md '설정 규약' 과 같다.
 * 숫자는 매번 다시 읽고, 이 표는 **그 포트가 무슨 역할인지** 같은 뜻만 갖는다
 * (docs/ports.md '7. 포트 지도 화면이 읽는 곳').
 */
function rtpRows() {
  return [];
}

function controlRows() {
  return [];
}

function internalHttpRows() {
  const { routes } = loadRoutes(config.nginxStackPath);
  return routes
    .map((r) => ({ name: r.name, ports: r.ports, location: r.location || null }))
    .sort((a, b) => (a.ports[0] || 0) - (b.ports[0] || 0));
}

// 공유기에서 열어야 하는 것만 뽑는다 — "포워딩 확인할 때" 화면이 바로 이걸
// 보여줘야 한다. 80/443 은 어느 settings.ini 에도 없는 값이라 고정으로 둔다
// (nginx/nginx-stack.conf 의 public_http_port/public_https_port 는 표준 포트를
// 그대로 넘기는 지금 배치에서는 비어 있는 것이 정상 — docs/ports.md '5. 공유기 포트 포워딩').
function forwardingChecklist(rtp, control) {
  const rows = [
    { protocol: 'TCP', port: '80', purpose: 'HTTP (Let\'s Encrypt 갱신·리다이렉트)' },
    { protocol: 'TCP', port: '443', purpose: 'HTTPS — 모든 웹/대시보드/API' },
  ];
  for (const r of [...rtp, ...control]) {
    if (!r.forwarded || !r.value) continue;
    rows.push({ protocol: r.protocol, port: r.value, purpose: r.role || r.name });
  }
  return rows;
}

function build() {
  const rtp = rtpRows();
  const control = controlRows();
  return {
    rtp,
    control,
    internalHttp: internalHttpRows(),
    forwardingChecklist: forwardingChecklist(rtp, control),
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { build };
