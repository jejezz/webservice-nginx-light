const express = require('express');
const log = require('../logger');
const scaffold = require('../services/scaffold');
const register = require('../services/register');
const removal = require('../services/remove');
const inspector = require('../services/inspect');

/**
 * 서비스 추가 마법사 (/manager/api/wizard). 마운트하는 쪽(routes/api.js)이
 * 이미 requireAuth 를 걸어 둔다 — 로그인한 관리자라면 누구나 읽기 전용
 * 엔드포인트(기본값 조회, 점검, 명령 미리보기)는 쓸 수 있다.
 *
 * 디스크에 새 디렉터리를 만드는 단 하나의 쓰기 동작(POST /scaffold)만
 * 여기서 한 번 더 role 을 본다 — administrator.role 은 이미 있었지만
 * 어떤 라우트도 검사하지 않던 값이다(auth/session.js 참고). 처음 생기는
 * "디스크에 쓰는" 동작이라 이 기회에 채운다.
 */
function requireAdminRole(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'admin_role_required', message: '관리자(admin) 권한이 필요합니다.' });
  }
  next();
}

const router = express.Router();

router.get('/scaffold/defaults', (req, res) => {
  res.json(scaffold.defaults());
});

router.post('/scaffold', requireAdminRole, (req, res) => {
  const { name, port, track } = req.body || {};

  try {
    const result = scaffold.create({ name, port: Number(port), track });
    log.info(`서비스 스캐폴드 생성: ${result.dir} (${req.user.username})`);
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof scaffold.ScaffoldError) {
      const status = err.code === 'already_exists' || err.code === 'port_in_use' ? 409 : 400;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    log.error(`서비스 스캐폴드 생성 실패: ${err.message}`);
    res.status(500).json({ error: 'scaffold_failed', message: '만드는 중 오류가 났습니다. 로그를 확인하세요.' });
  }
});

// 슬러그가 아닌 :name 은 여기서 먼저 걸러낸다 — 아래 register.js 는 그 값을
// 그대로 파일 경로에 쓰므로, 라우트 자리에서부터 형식을 확인해 둔다.
router.param('name', (req, res, next, name) => {
  if (!scaffold.SLUG_RE.test(name)) {
    return res.status(400).json({ error: 'invalid_name' });
  }
  next();
});

// 추가한 서비스를 지운다 (휴지통으로 옮김 — services/remove.js). 지우기 전에 무엇이 일어나는지를 먼저 묻는다.
router.get('/services/:name/remove-plan', requireAdminRole, async (req, res, next) => {
  try {
    res.json(await removal.plan(req.params.name));
  } catch (err) {
    sendRemoveError(err, res, next);
  }
});

router.delete('/services/:name', requireAdminRole, async (req, res, next) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'json_required', message: 'JSON 으로 보내야 합니다.' });
  }
  try {
    res.json(await removal.remove({ name: req.params.name, confirm: req.body?.confirm, by: req.user.username }));
  } catch (err) {
    sendRemoveError(err, res, next);
  }
});

function sendRemoveError(err, res, next) {
  if (err instanceof removal.RemoveError || err instanceof scaffold.ScaffoldError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'pm2_failed' ? 500 : 400;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  return next(err);
}

// 이미 받아 둔 폴더(services/ 안에 직접 clone 한 것)를 서비스로 등록하기 전의 읽기 전용 진단 (services/inspect.js).
// 그 폴더의 코드는 실행하지 않는다.
router.get('/inspect', (req, res) => {
  res.json({ candidates: inspector.candidates() });
});

router.get('/inspect/:name', async (req, res, next) => {
  try {
    res.json(await inspector.inspect(req.params.name));
  } catch (err) {
    if (err instanceof scaffold.ScaffoldError) return res.status(400).json({ error: err.code, message: err.message });
    next(err);
  }
});

// 플러그인 자체 진단(package.json 의 doctor 스크립트)을 실행한다. **그 폴더의 코드를 실행**하므로 관리자가 버튼을
// 눌렀을 때만, JSON 본문만 받는다 (services/inspect.js 의 경계 참고).
router.post('/inspect/:name/self-diagnosis', requireAdminRole, async (req, res, next) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'json_required', message: 'JSON 으로 보내야 합니다.' });
  }
  try {
    const result = await inspector.runSelfDiagnosis(req.params.name, req.body?.cwd);
    log.info(`플러그인 자체 진단 실행: ${req.params.name} (${req.user.username})`);
    res.json(result);
  } catch (err) {
    if (err instanceof inspector.InspectError || err instanceof scaffold.ScaffoldError) {
      const status = err.code === 'busy' ? 409 : err.code === 'not_found' ? 404 : 400;
      return res.status(status).json({ error: err.code, message: err.message });
    }
    next(err);
  }
});

router.get('/register/:name/checklist', (req, res) => {
  if (!register.exists(req.params.name)) return res.status(404).json({ error: 'unknown_service' });
  const items = register.checklist(req.params.name, { track: req.query.track });
  res.json({ items });
});

router.post('/register/:name/check/:checkId', async (req, res, next) => {
  if (!register.exists(req.params.name)) return res.status(404).json({ error: 'unknown_service' });
  try {
    const port = req.body?.port ? Number(req.body.port) : undefined;
    res.json(await register.runCheck(req.params.name, req.params.checkId, { port }));
  } catch (err) {
    next(err);
  }
});

router.get('/register/:name/commands', (req, res) => {
  if (!register.exists(req.params.name)) return res.status(404).json({ error: 'unknown_service' });
  const port = req.query.port ? Number(req.query.port) : undefined;
  res.json({ commands: register.commands(req.params.name, { port, track: req.query.track }) });
});

module.exports = { router, requireAdminRole };
