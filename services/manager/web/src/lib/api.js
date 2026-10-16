// 모든 API는 SPA와 같은 오리진의 /manager/api 아래에 있다.
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/+$/, '')}/api`;

export class ApiError extends Error {
  constructor(message, status, code, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    // 항목별 오류처럼 본문에 더 실려 오는 것이 있다 (설정 폼).
    this.data = data;
    // 같은 code 안에서 상황을 더 나눌 때 쓴다.
    // (예: password_confirm_required 의 signup / reset)
    this.reason = data?.reason;
    // too_many_attempts 에서만 온다 — 로그인 화면이 카운트다운을 보여줄 때 쓴다.
    this.retryAfterSec = data?.retryAfterSec;
  }
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });

  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!res.ok) {
    throw new ApiError(data?.message || data?.error || `HTTP ${res.status}`, res.status, data?.error, data);
  }

  return data;
}

export const api = {
  // 로그인 화면이 어느 장비인지 표시하기 위해 부른다. 인증 전에도 응답한다.
  host: () => request('/host'),

  // passwordConfirm 은 비밀번호가 **새로 저장되는** 경우(신규 등록, 승인 전
  // 재설정)에만 보낸다. 서버는 '없음' 과 '빈 문자열' 을 구분하므로 undefined 면
  // 아예 넣지 않는다.
  login: (username, password, passwordConfirm) =>
    request('/login', {
      method: 'POST',
      body: JSON.stringify(
        passwordConfirm === undefined ? { username, password } : { username, password, passwordConfirm }
      ),
    }),
  logout: () => request('/logout', { method: 'POST' }),
  me: () => request('/me'),
  overview: () => request('/overview'),
  // CPU · RAM · 저장소 · 네트워크와 최근 10분 기록, 서비스별 사용량.
  metrics: () => request('/metrics'),
  // 설치본 점검 — 저장소 뿌리의 check-all.sh 를 줄 단위로. 화면은 번호만 보낸다.
  checks: {
    list: () => request('/checks'),
    run: (id) => request(`/checks/${id}/run`, { method: 'POST' }),
    // 어긋난 줄의 '자동으로 반영' — 구축 마법사의 자동 실행을 점검 번호로 부른다. 보내는 것은 sudo 비밀번호뿐이다.
    apply: (id, secrets = {}) => request(`/checks/${id}/apply`, { method: 'POST', body: JSON.stringify(secrets) }),
    applyStatus: (id, from = 0) => request(`/checks/${id}/apply?from=${from}`),
    applyCancel: (id) => request(`/checks/${id}/apply/cancel`, { method: 'POST' }),
  },
  // 중앙 감시 에이전트. 응답에 siteSecret 은 없다.
  central: {
    status: () => request('/central'),
    enroll: (code) => request('/central/enroll', { method: 'POST', body: JSON.stringify({ code }) }),
    send: () => request('/central/send', { method: 'POST' }),
  },
  service: (name) => request(`/services/${encodeURIComponent(name)}`),
  serviceHealth: (name) => request(`/services/${encodeURIComponent(name)}/health`),

  // RTP·시그널링·내부 HTTP 포트 전체 지도. 공유기 포워딩 확인용 (docs/ports.md '7. 포트 지도 화면이 읽는 곳').
  portMap: () => request('/port-map'),

  // 문서(git 이 추적하는 .md 전부)와 변경 이력(git log).
  docs: {
    list: () => request('/docs'),
    content: (path) => request(`/docs/content?path=${encodeURIComponent(path)}`),
  },
  // 설치 가이드 PDF — 세션이 있어야 내려받는다. 새 탭으로 열지 않고 fetch 로 받아 오류(세션 만료 등)를
  // 화면에서 보여 준다.
  guides: {
    list: () => request('/guides'),
    download: async (name) => {
      const res = await fetch(`${API_BASE}/guides/download?name=${encodeURIComponent(name)}`, {
        credentials: 'same-origin',
      });
      if (!res.ok) {
        let data = null;
        try {
          data = await res.json();
        } catch {
          /* 본문이 JSON 이 아니면 상태 코드만 쓴다 */
        }
        throw new ApiError(data?.message || data?.error || `HTTP ${res.status}`, res.status, data?.error, data);
      }
      return res.blob();
    },
  },
  changelog: (scope, limit) => {
    const params = new URLSearchParams();
    if (scope) params.set('scope', scope);
    if (limit) params.set('limit', limit);
    const qs = params.toString();
    return request(`/changelog${qs ? `?${qs}` : ''}`);
  },

  // 구축 마법사 — 단계 정의와 점검 실행.
  setup: {
    overview: () => request('/setup'),
    check: (stepId) => request(`/setup/check/${encodeURIComponent(stepId)}`, { method: 'POST' }),
    // 파라미터를 서비스의 settings.ini 에 쓴다. 반영은 사람이 --apply 로 한다.
    saveSettings: (stepId, values) =>
      request(`/setup/settings/${encodeURIComponent(stepId)}`, {
        method: 'PUT',
        body: JSON.stringify(values),
      }),

    // 단계의 명령을 마법사가 대신 돌린다 (사용자가 '자동으로' 를 골랐을 때만).
    // 돌리는 것은 서버가 정한 명령이고 여기서 보내는 것은 sudo 비밀번호뿐이다.
    autoStart: (stepId, secrets = {}) =>
      request(`/setup/auto/${encodeURIComponent(stepId)}`, {
        method: 'POST',
        body: JSON.stringify(secrets),
      }),
    autoStatus: (stepId, from = 0) => request(`/setup/auto/${encodeURIComponent(stepId)}?from=${from}`),
    autoCancel: (stepId) => request(`/setup/auto/${encodeURIComponent(stepId)}/cancel`, { method: 'POST' }),

    // 사람만 확인할 수 있는 것의 기록. 통과로 바꾸는 것이 아니라 적어 두는 것이다.
    attest: (stepId, note) =>
      request(`/setup/attest/${encodeURIComponent(stepId)}`, {
        method: 'POST',
        body: JSON.stringify({ note: note || '' }),
      }),
    unattest: (stepId) =>
      request(`/setup/attest/${encodeURIComponent(stepId)}`, { method: 'DELETE' }),
  },

  // 서비스 추가 마법사 — 1단계(스캐폴드 생성)와 2단계(등록 + 무결성 확인).
  // manager 는 2단계의 명령을 대신 실행하지 않는다 — commands() 는 복사용
  // 문자열만 돌려준다.
  wizard: {
    defaults: () => request('/wizard/scaffold/defaults'),
    // 이미 받아 둔 폴더(services/ 안에 직접 clone 한 것)의 읽기 전용 진단. 코드는 실행하지 않는다.
    inspectCandidates: () => request('/wizard/inspect'),
    inspect: (folder) => request(`/wizard/inspect/${encodeURIComponent(folder)}`),
    // 플러그인 자체 진단(package.json 의 doctor)을 실행한다 — 그 폴더의 코드를 실행하므로 관리자가 버튼을 눌렀을 때만.
    selfDiagnosis: (folder, cwd) =>
      request(`/wizard/inspect/${encodeURIComponent(folder)}/self-diagnosis`, {
        method: 'POST',
        body: JSON.stringify({ cwd }),
      }),
    // 추가한 서비스를 지운다(휴지통으로 이동). plan 은 무슨 일이 일어나는지를 먼저 묻는 것이다.
    removePlan: (folder) => request(`/wizard/services/${encodeURIComponent(folder)}/remove-plan`),
    removeService: (folder, confirm) =>
      request(`/wizard/services/${encodeURIComponent(folder)}`, {
        method: 'DELETE',
        body: JSON.stringify({ confirm }),
      }),
    scaffold: (payload) => request('/wizard/scaffold', { method: 'POST', body: JSON.stringify(payload) }),
    checklist: (name, track) =>
      request(`/wizard/register/${encodeURIComponent(name)}/checklist${track ? `?track=${encodeURIComponent(track)}` : ''}`),
    check: (name, checkId, port) =>
      request(`/wizard/register/${encodeURIComponent(name)}/check/${encodeURIComponent(checkId)}`, {
        method: 'POST',
        body: JSON.stringify(port ? { port } : {}),
      }),
    commands: (name, { port, track } = {}) => {
      const params = new URLSearchParams();
      if (port) params.set('port', port);
      if (track) params.set('track', track);
      const qs = params.toString();
      return request(`/wizard/register/${encodeURIComponent(name)}/commands${qs ? `?${qs}` : ''}`);
    },
  },

  // 관리자 콘솔 — 일반 로그인과 별개의 세션을 쓴다.
  admin: {
    login: (username, password) =>
      request('/admin/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    logout: () => request('/admin/logout', { method: 'POST' }),
    me: () => request('/admin/me'),
    list: () => request('/admin/administrators'),
    create: (payload) =>
      request('/admin/administrators', { method: 'POST', body: JSON.stringify(payload) }),
    update: (id, patch) =>
      request(`/admin/administrators/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    remove: (id) => request(`/admin/administrators/${id}`, { method: 'DELETE' }),
  },
};
