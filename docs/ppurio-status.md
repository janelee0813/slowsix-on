# 뿌리오 알림톡 연동 현황 (2026-10-01)

- 계정: `slowsix`, 카카오 채널: `슬로우식스(@slowsix)`.
- Supabase Secrets: `PPURIO_ACCOUNT`, `PPURIO_ACCESS_KEY` 저장 확인. 인증키는 저장소에 기록하지 않는다.
- 승인된 템플릿:
  - 예약 취소: `ppur_2026091713583347407004301`
  - 예약 거절: `ppur_2026091713580424417116780`
  - 예약 확정: `ppur_2026091713573124417016883`
  - 승인·입금 안내: `ppur_2026091713565824417631569`
  - 관리자 새 예약 요청: `ppur_2026091713562747407967598`

## 실제 서버 검사

`ppurio-test`는 인증 연결만 진단하며 메시지 발송이나 DB 변경을 하지 않는다.
게이트웨이 JWT 검증을 유지하고 함수 내부에서 서버 전용 키를 추가 검증한다.
Dashboard Test에서 Authorization에 기존 프로젝트 anon JWT, apikey에는
Add secret key로 넣은 서버 키를 사용한다. 브라우저 사이트에 서버 키를 넣지 않는다.

실제 응답: `stage=token`, `providerHttpStatus=400`, `providerCode="3003"`,
`authenticated=false`, `messageSent=false`.
뿌리오 공식 API 문서에서 3003은 유효하지 않은 IP다. 발송 요청은 하지 않았다.

Supabase Edge Functions의 발신 IP는 고정되지 않으므로 현재 IP 하나를 등록하는 것으로
지속적인 자동 발송을 보장할 수 없다. 고정 IP를 가진 중계 서버 또는 뿌리오가 공식 지원하는
서버리스 인증 방식을 먼저 결정해야 한다. IP 제한 해제/전체 허용은 적용하지 않았다.

## Fixie 중계 구성

- Fixie HTTP/HTTPS 앱 `slowsix-ppurio` 활성화. 고정 IP는 `52.87.82.133`, `52.5.155.132`.
- Vercel Production에 `FIXIE_URL`을 Secret으로 저장했다. 값은 저장소에 기록하지 않는다.
- `/api/ppurio-relay`는 HMAC으로 인증한 서버 요청만 받으며, 뿌리오 토큰 발급 주소만 호출한다.
  HTTPS CONNECT를 사용하고 인증키/응답 토큰을 로그에 남기지 않는다.
- Supabase `ppurio-test`에 `{"route":"fixie"}`를 보내면 중계 경로를 검사한다.
  결과에는 인증 성공 여부만 나오며 토큰이나 인증키는 반환하지 않는다.
- 뿌리오에 두 IP를 허용 목록으로 등록하는 사용자 확인을 기다리고 있다.
- 실제 Fixie 경유 인증 검사와 알림톡 발송은 아직 완료하지 않았다.

추가 확인: 현재 템플릿은 `#{닉네임}` 등 카카오 변수 표기지만 뿌리오 공개 API의
changeWord 문서는 `var1` → `[*1*]` 치환으로 안내한다. 실제 API 발송 전 변수 연결 방식도
확인해야 한다. 치환 방식을 추측해서 발송하지 않는다.

템플릿 편집 화면의 변수추가 메뉴도 `[*이름*]`, `[*1*]` 형식만 제공한다.
수정 시 재심사(영업일 1~2일)가 필요하다는 안내를 확인했다. 기존 승인 상태를 유지하기 위해
아직 템플릿 수정을 저장하지 않았다.

- https://message.ppurio.com/api-docs/
- https://supabase.com/docs/guides/troubleshooting/why-supabase-edge-functions-cannot-provide-static-egress-ips-for-whitelisting-3d78b0
- https://usefixie.com/documentation/http-and-https-requests
