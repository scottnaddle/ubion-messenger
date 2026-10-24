# UBION Messenger iOS (iPhone + iPad) — Mac mini 실행 방법

준비: Xcode(App Store) 설치 후 한 번 실행해 추가 구성요소 설치, Node 20+ (`brew install node`).

1. 소스 받기: `git clone ubm-mobile.bundle ubm-mobile && cd ubm-mobile && git checkout feature/mobile-capacitor`
   (또는 zip 압축 해제) → `cd desktop`
2. `npm ci` (iOS 프로젝트가 node_modules/@capacitor/* 를 Swift Package로 참조함)
3. `npm run cap:sync` (모바일 웹 번들 빌드 + ios/App/App/public 복사)
4. `npx cap open ios` (또는 Xcode에서 `desktop/ios/App/App.xcodeproj` 열기). 첫 실행 시 Swift Package 다운로드 대기.
5. Xcode → Settings → Accounts 에서 개인 Apple ID 추가.
6. 프로젝트 App → target App → Signing & Capabilities: "Automatically manage signing" 체크, Team = (Personal Team).
   번들 ID 충돌 시 `global.ubion.messenger.dev.scott` 처럼 바꾸기.
7. iPhone/iPad를 USB 연결 → 기기에서 "신뢰" → 기기 설정 > 개인정보 보호 및 보안 > 개발자 모드 켜기(재부팅).
8. Xcode 상단에서 기기 선택 → ▶ Run.
9. 첫 실행 시 "신뢰할 수 없는 개발자" → 기기 설정 > 일반 > VPN 및 기기 관리 > 개발자 앱 신뢰.
10. 무료 Apple ID 서명은 7일 후 만료 → 다시 Run 하면 갱신. 푸시 없음.

UI만 보기: 시뮬레이터/브라우저에서 `dist-mobile/index.html?mock=1` (가짜 데이터).
