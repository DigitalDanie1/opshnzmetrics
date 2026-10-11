#!/bin/zsh
# 예약 실행 진입점. GitHub 저장소가 연결돼 있으면 매일 빌드는 GitHub Actions 가 하므로 여기선 최신본을 내려받기만 한다.
# 저장소가 없으면(예전 방식) 이 Mac 에서 직접 빌드한다.
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p logs
echo "── $(date '+%Y-%m-%d %H:%M:%S') ──" >> logs/auto.log
if git remote get-url origin >/dev/null 2>&1; then
  git pull --rebase --autostash >> logs/auto.log 2>&1
else
  node publish.mjs --auto >> logs/auto.log 2>&1
fi
echo "exit $?" >> logs/auto.log
