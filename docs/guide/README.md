# 구현 가이드 — 목차와 전체 흐름

이 폴더는 빈 우분투 장비에 이 저장소를 세우고, 세운 뒤 고치고 늘리는 방법을
**실제로 따라 할 수 있게** 적은 곳입니다. 서비스가 무엇을 하는지는
[../services.md](../services.md), 포트는 [../ports.md](../ports.md) 에 있고,
여기서는 **장비 위에서 하는 일**만 다룹니다.

## 전체 흐름

설치부터 운영까지는 한 줄로 이어집니다. 앞 단계를 건너뛰면 뒤 단계가
"없습니다" 로 멈추고, 그 멈춤은 대개 원인과 멀리 떨어진 자리에서 드러납니다.

```
 ① 외부 준비물          (공인 인증서를 쓸 때) 도메인·A 레코드 · 80/443 이 열리는 공인 IP
    (장비 밖)            · 공유기 포워딩
        │
        ▼
 ② ./bootstrap.sh       안내 셸. node 20 → pm2 → manager 준비(--apply)까지
    (sudo 는 사람이)     "마법사까지 가는 길" 만 닦는다
        │
        ▼
 ③ 구축 마법사          /manager/setup — 9단계(필수 5 · 선택 4)
    (브라우저 + 터미널)  사이트 값 → pm2 → DB → 서버 인증서 결정 → nginx 라우트
                         → (선택) 공인 인증서 발급 · nginx 반영 · 갱신 · DNS 점검
        │
        ▼
 ④ 서비스별 준비         각 services/<이름> 의 npm run setup (마법사 단계 안에서 부른다)
        │
        ▼
 ⑤ ./check-all.sh       설치본이 저장소의 선언과 같은지 한 번에 본다
        │
        ▼
 ⑥ 운영                  고친 뒤 반영(npm run build && npm run restart),
                         서비스 추가, 되돌리기
```

①은 이 장비 안에서 만들 수 없는 것들이라 **가장 먼저** 확인합니다. 공인 인증서로
밖에서 접속하는 배치에서 도메인과 열리는 공인 IP 는 대체 수단이 없습니다. 못 갖추면
LAN 전용(`tls_mode = private`)으로 세우는 것이 맞습니다.

②~⑤는 여러 번 돌려도 안전하게 만들어져 있습니다. 점검 모드가 기본이고,
바꾸는 모드(`--apply` · `--install`)는 사람이 명시적으로 부릅니다. 마법사는
sudo 를 부르지 않고 명령을 **보여 주기만** 합니다.

## 장별 안내

| 장 | 다루는 것 | 이럴 때 읽습니다 |
|---|---|---|
| [install.md](install.md) | 외부 준비물, 브랜치 선택, `bootstrap.sh`, Node 설치, 구축 마법사 9단계, 서비스별 `npm run setup`, `check-all.sh`, 빈 장비 설치 시험 | 새 장비를 처음 세울 때. 재현성 시험을 할 때 |
| [infrastructure.md](infrastructure.md) | `site/settings.ini`, nginx 생성기와 반영, `tls_mode`, 사설 CA · Let's Encrypt, pm2 기동과 부팅 복원, MariaDB 계정·비밀번호·스키마, 저장소를 옮길 때 | 서비스들이 함께 기대는 바닥을 고치거나 진단할 때 |
| [contracts.md](contracts.md) | `/health` 응답 형식, 점검 스크립트의 `--check --json` 형식, `settings-schema.json` · `settings.ini` · `.applied-settings` 규약 | 점검·헬스·설정 폼을 새로 만들거나 읽을 때 |
| [declarations.md](declarations.md) | `nginx-conf/*.ini` · `pm2-conf/*.ini` · `db-conf/*.ini` 의 키와 규칙 | 라우트·프로세스·DB 를 선언할 때 |
| [rollout.md](rollout.md) | 서비스 추가(plug-in), 고친 뒤 반영, 안전한 반영 순서, 되돌리기 | 이미 돌고 있는 장비에 무언가를 올리거나 내릴 때 |

## 할 일로 찾기

| 하려는 일 | 먼저 볼 곳 |
|---|---|
| 새 장비를 세운다 | [install.md](install.md) 처음부터 |
| 설치 전에 무엇을 받아 와야 하는지 | [install.md](install.md) '시작하기 전에 — 장비 밖에서 준비할 것' |
| node 가 12·18 이라 막혔다 | [install.md](install.md) 'Node.js 20' |
| 마법사의 어느 단계가 무엇을 하는지 | [install.md](install.md) '마법사 단계' |
| 호스트 이름·tls_mode 를 바꾼다 | [infrastructure.md](infrastructure.md) '사이트 값' |
| 라우트를 추가하거나 바꾼다 | [declarations.md](declarations.md) → [infrastructure.md](infrastructure.md) 'nginx 반영' |
| 사설 CA 에서 Let's Encrypt 로 옮긴다 | [infrastructure.md](infrastructure.md) '공인 인증서' |
| 재부팅 뒤 앱이 안 뜬다 | [infrastructure.md](infrastructure.md) 'pm2 — 부팅 복원' |
| DB 비밀번호가 "틀렸다" 고 나온다 | [infrastructure.md](infrastructure.md) 'MariaDB — 계정 정책' |
| 코드를 고쳤다 | [rollout.md](rollout.md) '고친 뒤 반영' |
| plug-in 서비스를 붙인다 | [rollout.md](rollout.md) '서비스 추가' + [declarations.md](declarations.md) |
| 반영했더니 깨졌다 | [rollout.md](rollout.md) '되돌리기' |
| 저장소 디렉터리를 다른 곳으로 옮겼다 | [infrastructure.md](infrastructure.md) '저장소를 옮길 때' |

## 이 가이드 전체에 걸친 약속

- **명령은 저장소 뿌리 기준입니다.** 다른 자리에서 부르는 명령은 `cd` 를 함께
  적습니다. 스크립트는 전부 자기 위치를 기준으로 경로를 계산하므로 어디서
  불러도 같게 동작합니다.
- **점검과 반영은 다른 명령입니다.** 인자 없이 부르거나 `--check` 를 주면 아무것도
  바꾸지 않습니다. 바꾸는 쪽은 `--apply` · `--install` · `--skip-install` 처럼
  이름에 드러납니다.
- **판정 표시는 셋입니다.** `[ok]` 됐다 · `[--]` 아직 안 했다(또는 안 해도 된다) ·
  `[!!]` 문제다. 기계가 읽는 형식은 `--check --json` 이고 규약은
  [contracts.md](contracts.md) 에 있습니다.
- **장비마다 다른 값은 커밋하지 않습니다.** 그런 값은 `settings.ini` 에 두고,
  무엇을 받을지는 커밋되는 `settings-schema.json` 이 정합니다.
- **sudo 경계.** 웹 화면(manager·대시보드)은 sudo 를 부르지 않습니다. root 가
  필요한 일은 사람이 터미널에서 합니다.

## 아직 안 된 것

이 저장소는 **빈 장비에서 끝까지 설치해 본 적이 없습니다.** 설치 중 막히는 자리는
저장소의 결함으로 보고 [install.md](install.md) 의 '막히는 곳' 에 보태 주세요.
contracts · declarations · rollout 의 예시 일부는 지금은 없는 서비스(통화 시스템)를
예로 들고 있습니다. 규칙 자체는 그대로 맞습니다.
