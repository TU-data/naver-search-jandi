## Naver Search → Jandi notifier

매일 지정한 시간에 네이버 모바일 검색 결과 3개(티유치과, tu치과, 제로네이트)를 캡쳐해서 가로로 합친 뒤 잔디 웹훅에 이미지 URL을 전달합니다. 최종 이미지는 `images` 폴더에 보관되며, 1주일(기본값) 이상 된 이미지는 자동으로 삭제됩니다. 잔디에는 CDN(jsDelivr) URL을 사용해 바로 표시 가능한 링크를 전달합니다.

### 구성 요소
- `src/index.js` – Playwright로 모바일 페이지를 캡쳐하고 Sharp로 이미지를 병합한 뒤 잔디 웹훅으로 전송
- `images/` – GitHub Actions가 커밋하는 결과 이미지 저장소 (`latest.png` 포함)
- `.github/workflows/naver-monitor.yml` – 매일 스케줄 실행 및 수동 실행(workflow_dispatch) 지원

## 준비 사항
1. **Jandi Webhook 생성** – 잔디 커넥트 웹훅 URL을 만들어 GitHub Secrets에 `JANDI_WEBHOOK_URL` 이름으로 저장합니다.
2. **Playwright 브라우저 설치** – 로컬 실행 시 `npx playwright install chromium`을 먼저 실행하세요. GitHub Actions에서는 워크플로에서 자동으로 설치합니다.
3. **환경 변수** – 로컬 테스트 시 `.env` 파일을 `.env.example`을 참고해 생성합니다.

```bash
cp .env.example .env
```

- `JANDI_WEBHOOK_URL` : 잔디 웹훅 URL (CI에서는 Secret으로 주입)
- `SEARCH_KEYWORDS` : 쉼표로 구분한 검색어 목록
- `RETENTION_DAYS` : 이미지 보관 일수 (기본 7일)
- `PAGE_WAIT_MS` : 결과 페이지 안정화 대기 시간(ms)
- `MAX_IMAGE_HEIGHT` : 각 검색 스크린샷을 상단 기준으로 잘라낼 최대 높이(px, 기본 0 → 자르지 않음). 필요 시 값 지정.
- `OUTPUT_WIDTH`, `OUTPUT_HEIGHT` : 최종 합성 이미지의 목표 폭/높이(px, 기본 500×500)
- `IMAGE_BASE_URL` : 로컬 실행 시 이미지를 외부에 노출할 수 있는 정적 URL (CI에서는 `https://cdn.jsdelivr.net/gh/<OWNER>/<REPO>@main/images`로 자동 계산)

## 실행 방법

### 로컬 테스트
```bash
npm install
npx playwright install chromium
npm run monitor
```

### GitHub Actions 스케줄
- 기본 cron: `0 22 * * *` (UTC 기준 22:00 → 한국시간 오전 7시). 원하는 주기로 수정하려면 `.github/workflows/naver-monitor.yml`의 `schedule` 블록을 편집하세요.
- 수동 실행은 GitHub Actions 탭에서 `Run workflow` 버튼으로 가능.
- 워크플로는 실행 후 `images/` 폴더를 커밋/푸시하므로 저장소에 쓰기 권한이 필요합니다.

## 동작 설명
1. Playwright(Chromium, Pixel 5 프로필)가 `m.search.naver.com`에서 지정된 검색어로 결과 페이지를 로딩하고 각각 전체 페이지 스크린샷을 저장합니다.
2. Sharp가 세 개의 이미지를 가로로 이어 붙여 `images/naver-search-YYYYMMDD-HHMMSS.png`를 생성하고, 동일 이미지를 `images/latest.png`로 복사합니다.
3. 7일 이상 지난 이미지 파일은 `latest.png`를 제외하고 삭제합니다.
4. jsDelivr CDN URL(`https://cdn.jsdelivr.net/gh/<OWNER>/<REPO>@main/images/...`)을 사용해 잔디 웹훅에 이미지가 포함된 메시지를 전송하므로, 잔디에서 바로 이미지를 볼 수 있습니다.
5. 최종 이미지는 `OUTPUT_WIDTH` × `OUTPUT_HEIGHT` 값(기본 500×500)에 맞게 축소되어 고정 크기로 전달됩니다.

필요 시 `SEARCH_KEYWORDS`, `RETENTION_DAYS`, `PAGE_WAIT_MS` 등의 환경 변수를 수정해 요구사항에 맞출 수 있습니다.
