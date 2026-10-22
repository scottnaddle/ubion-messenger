#!/usr/bin/env bash
# UBION Messenger 릴리스: CI 산출물을 받아 공개 저장소에 GitHub Release 로 게시합니다.
# 사용법:  desktop/scripts/release.sh [버전]   (기본값: desktop/package.json 의 version)
# 필요: gh CLI 로그인 상태 (gh auth status). 토큰을 코드/시크릿에 저장하지 않습니다.
set -euo pipefail
SRC_REPO="scottnaddle/ubion-messenger"
PUB_REPO="scottnaddle/ubion-messenger-releases"
cd "$(dirname "$0")/.."
VER="${1:-$(node -p 'require("./package.json").version')}"; VER="${VER#v}"; TAG="v$VER"
SHA="$(git rev-parse HEAD)"
echo "▶ $TAG  (commit ${SHA:0:7})"

if ! gh repo view "$PUB_REPO" >/dev/null 2>&1; then
  echo "▶ 공개 저장소 생성: $PUB_REPO"
  tmp="$(mktemp -d)"
  gh repo create "$PUB_REPO" --public --description "UBION Messenger 설치 파일 배포" >/dev/null
  cat > "$tmp/README.md" <<'MD'
# UBION Messenger 다운로드

UBION 사내 메신저(DaouOffice) 데스크톱 앱의 **설치 파일 배포 전용** 저장소입니다. 소스 코드는 포함되어 있지 않습니다.

👉 **[최신 버전 다운로드](../../releases/latest)**

| OS | 파일 |
|---|---|
| Windows | `UBION-Messenger-x.y.z-Setup.exe` |
| macOS (Apple Silicon) | `UBION-Messenger-x.y.z-arm64.dmg` |
| macOS (Intel) | `UBION-Messenger-x.y.z-x64.dmg` |

- Windows: 앱이 자동으로 업데이트를 받아 설치합니다.
- macOS: 새 버전이 나오면 앱이 알려주고 dmg 를 내려받아 엽니다. 앱을 '응용 프로그램' 폴더로 끌어 '대치'를 선택하세요.
  처음 실행 시 서명되지 않은 앱 경고가 나오면 Finder 에서 앱을 우클릭 → '열기' 를 선택하세요.
MD
  gh api -X PUT "repos/$PUB_REPO/contents/README.md" -f message="README" \
    -f content="$(base64 < "$tmp/README.md" | tr -d '\n')" >/dev/null
  rm -rf "$tmp"
fi

if gh release view "$TAG" -R "$PUB_REPO" >/dev/null 2>&1; then
  echo "✖ $TAG 이미 게시됨: https://github.com/$PUB_REPO/releases/tag/$TAG"; exit 1
fi

echo "▶ CI 대기 (commit ${SHA:0:7})"
RUN=""
for _ in $(seq 1 60); do
  RUN="$(gh run list -R "$SRC_REPO" --workflow build.yml --commit "$SHA" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  [ -n "$RUN" ] && break; sleep 10
done
[ -n "$RUN" ] || { echo "✖ 이 커밋의 CI 실행을 찾지 못함 (push 했나요?)"; exit 1; }
gh run watch "$RUN" -R "$SRC_REPO" --exit-status >/dev/null || { echo "✖ CI 실패: https://github.com/$SRC_REPO/actions/runs/$RUN"; exit 1; }

DIR="$(mktemp -d)"; trap 'rm -rf "$DIR"' EXIT
gh run download "$RUN" -R "$SRC_REPO" -D "$DIR"
shopt -s nullglob
FILES=( "$DIR"/*/*.dmg "$DIR"/*/*.zip "$DIR"/*/*.exe "$DIR"/*/*.blockmap "$DIR"/*/latest*.yml )
for need in latest.yml latest-mac.yml "UBION-Messenger-$VER-Setup.exe" "UBION-Messenger-$VER-arm64.dmg" "UBION-Messenger-$VER-x64.dmg"; do
  ls "$DIR"/*/"$need" >/dev/null 2>&1 || { echo "✖ 산출물 누락: $need"; exit 1; }
done
grep -q "^version: $VER$" "$DIR"/*/latest.yml || { echo "✖ latest.yml 버전 불일치"; exit 1; }

echo "▶ 게시: ${#FILES[@]}개 파일"
gh release create "$TAG" -R "$PUB_REPO" --title "UBION Messenger $VER" \
  --notes "UBION Messenger $VER 설치 파일. Windows: Setup.exe / macOS: arm64(Apple Silicon)·x64(Intel) dmg." \
  "${FILES[@]}"
echo "✔ https://github.com/$PUB_REPO/releases/tag/$TAG"
