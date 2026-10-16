const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('../config');
const log = require('../logger');
const gitignore = require('./gitignore');
const scaffold = require('./scaffold');
const { loadEcosystem } = require('./registry');
const pm2 = require('./pm2');

const execFileAsync = promisify(execFile);

/**
 * 추가한 서비스를 지운다 (서비스 추가 마법사의 반대). **plug-in 만 지울 수 있다.**
 * 패키지에 포함된 서비스(.gitignore 에 예외가 열린 폴더)는 다른 서비스·문서·마법사 단계와 얽혀 있어
 * 폴더를 옮기는 것만으로는 깨끗이 빠지지 않는다 — 그런 것은 git 으로 직접 정리한다.
 *
 * 되돌릴 수 없는 일을 하지 않도록 **지우지 않고 휴지통으로 옮긴다**:
 *
 *   1. 그 서비스의 pm2 앱을 멈추고 목록에서 뺀다 (pm2 delete · pm2 save).
 *   2. 서비스 폴더를 통째로 `services/.removed/<이름>-<시각>/` 로 옮긴다 — 선언(nginx-conf ·
 *      pm2-conf)이 더는 읽히지 않아 대시보드에서 사라지고, 코드·설정은 그대로 남는다.
 *      되돌리려면 그 폴더를 `services/<이름>/` 로 옮기면 된다. (`services/*` 가 무시되므로 git 에도 안 잡힌다.)
 *
 * 경계:
 *   - plug-in 이 아니면 거절한다: 패키지에 든 하나(manager)와
 *     .gitignore 에 예외가 열린 폴더 전부.
 *   - 이름은 scaffold 와 같은 슬러그만 받고, 경로는 services/ 바로 아래 한 단계로만 만든다.
 *   - git 이 추적하는 파일이 있는 폴더는 거절한다 — 그건 git 으로 지워야 이력이 맞는다.
 *   - nginx 라우트는 여기서 지우지 못한다(sudo). 선언이 사라졌으니 **nginx 를 다시 반영**해야 라우트가 빠진다.
 */

const PROTECTED = new Set(['manager']);
const TRASH_DIR = '.removed';

class RemoveError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function servicesRoot() {
  return path.resolve(config.repoRoot, 'services');
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
}

/** 폴더에 git 이 추적하는 파일이 있는가. git 을 못 부르면 null — 호출자가 판단한다. */
async function trackedFileCount(name) {
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--', `services/${name}`], {
      cwd: config.repoRoot,
      timeout: 5000,
    });
    return stdout.split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

/** 이 폴더가 선언한 pm2 앱 이름들 (ecosystem 에서 폴더로 가려낸다). */
function appsOf(name) {
  return loadEcosystem(config.ecosystemPath)
    .filter((app) => app.dir === name)
    .map((app) => app.name);
}

/** 화면이 확인창에 보여 줄 것 — 아무것도 바꾸지 않는다. */
async function plan(name) {
  scaffold.assertValidName(name);
  if (PROTECTED.has(name)) {
    throw new RemoveError('protected', `${name} 은(는) 패키지에 포함된 서비스라 지울 수 없습니다.`);
  }

  // plug-in 은 .gitignore 에 예외가 없다 (services/* 가 무시한다). 예외가 열려 있으면 이 저장소의 일부다.
  if (gitignore.hasEntry(name)) {
    throw new RemoveError(
      'not_plugin',
      `${name} 은(는) 이 저장소의 일부(.gitignore 에 예외가 열려 있음)라 지울 수 없습니다 — plug-in 만 지울 수 있습니다.`,
    );
  }

  const dir = path.join(servicesRoot(), name);
  const exists = fs.existsSync(dir);
  const apps = appsOf(name);
  if (!exists && apps.length === 0) {
    throw new RemoveError('not_found', `services/${name} 폴더도, 그 폴더의 pm2 앱도 없습니다.`);
  }

  const tracked = exists ? await trackedFileCount(name) : 0;
  if (tracked) {
    throw new RemoveError(
      'tracked_by_git',
      `services/${name} 에 git 이 추적하는 파일이 ${tracked}개 있습니다 — git 으로 지워 이력을 맞추세요 (git rm -r services/${name}).`,
    );
  }

  return {
    name,
    dir: exists ? `services/${name}` : null,
    apps,
    trash: exists ? `services/${TRASH_DIR}/${name}-<시각>` : null,
  };
}

async function pm2Delete(appName, running) {
  // 메시지를 읽어 "없음" 을 가리지 않고, 먼저 목록에서 있는지 본다 — 없으면 지운 것과 같다.
  if (!running.has(appName)) return { app: appName, deleted: false, note: 'pm2 에 없었습니다' };
  try {
    await execFileAsync('pm2', ['delete', appName], { timeout: 15000 });
    return { app: appName, deleted: true };
  } catch (err) {
    const text = `${err.stderr || ''}${err.stdout || ''}`.trim();
    throw new RemoveError('pm2_failed', `pm2 delete ${appName} 에 실패했습니다: ${text.split('\n').filter(Boolean).slice(-2).join(' ') || err.message}`);
  }
}

/**
 * 지운다. confirm 은 사람이 친 이름 — 요청한 이름과 같지 않으면 거절한다.
 * 반환: { name, apps, movedTo, gitignore, next }
 */
async function remove({ name, confirm, by }) {
  const info = await plan(name);
  if (confirm !== name) {
    throw new RemoveError('confirm_mismatch', '확인용으로 입력한 이름이 서비스 이름과 다릅니다.');
  }

  // 1) pm2 — 폴더를 옮기기 전에 멈춘다. 돌고 있는 프로세스의 cwd 가 사라지지 않게.
  const pm2Results = [];
  const running = info.apps.length ? await pm2.list() : new Map();
  for (const app of info.apps) pm2Results.push(await pm2Delete(app, running));
  if (pm2Results.some((r) => r.deleted)) {
    try {
      await execFileAsync('pm2', ['save'], { timeout: 15000 });
    } catch (err) {
      log.warn(`서비스 삭제: pm2 save 실패 (${err.message})`);
    }
  }

  // 2) 폴더 → 휴지통. 같은 파일시스템 안의 rename 이라 중간 상태가 없다.
  let movedTo = null;
  if (info.dir) {
    const trashRoot = path.join(servicesRoot(), TRASH_DIR);
    fs.mkdirSync(trashRoot, { recursive: true });
    const target = path.join(trashRoot, `${name}-${stamp()}`);
    if (path.dirname(target) !== trashRoot) throw new RemoveError('invalid_name', '경로가 올바르지 않습니다.');
    fs.renameSync(path.join(servicesRoot(), name), target);
    movedTo = path.relative(config.repoRoot, target);
  }

  log.info(`서비스 삭제: ${name} → ${movedTo || '(폴더 없음)'} (${by})`);

  return {
    name,
    apps: pm2Results,
    movedTo,
    // nginx 는 sudo 가 필요해 여기서 못 한다. 선언이 사라졌으니 다시 반영하면 라우트가 빠진다.
    next: {
      text: 'nginx 라우트를 빼려면 다시 반영하세요 (구축 마법사의 nginx.routes 단계 → 자동으로, 또는 터미널에서):',
      command: 'cd nginx && sudo ./install_nginx_stack.sh --skip-install',
    },
  };
}

module.exports = { plan, remove, RemoveError, PROTECTED };
