# 슬로우식스ON 관리자 모드

## 범위

- 사이트의 작은 `관리자 모드` 링크 → `/admin.html`.
- 관리자: `slowsix` 1명. 모든 정산 항목 입력·수정·삭제, 운영자 초대·승인·거절·접근 중지, 변경 이력 조회.
- 운영자: 활성 상태 최대 2명. 전체 정산 조회, 스클 매출·고정비 등록. 기존 기록 수정·삭제는 관리자만.
- 영문으로 시작하는 영문·숫자 아이디 3~24자. 대소문자 구분 없이 소문자로 정규화.
- 비밀번호 8자 이상, UTF-8 기준 최대 72바이트. 흔한 패턴 일부를 차단. Supabase Auth에서 저장·검증하며 자체 비밀번호 테이블을 만들지 않음.
- 연속 10회 실패 후 다음 시도부터 15분 제한, 반복 시 최대 120분. 계정·접속 IP·초대·세션별 서버 제한. 성공하면 해당 계정 실패 기록 초기화.
- 초대: 관리자 화면에서 발급·복사, 48시간·1회 사용. 링크 원문은 서버에 저장하지 않음. 가입 후 승인 대기. 공용 가입 버튼 없음.
- 관리자 최초 설정: SQL Editor에서 24시간 일회용 링크 발급. 아이디는 `slowsix`로 고정. 첫 가입자가 자동으로 관리자가 되지 않음.

## Supabase 설치 순서

대상 프로젝트: **qhvwwdrwfzwpehfjntbv**. 기존 teugnaahpcpzejbdayyy 프로젝트에는 실행하지 않습니다.

1. SQL Editor → New query에서 `migrations/202609120001_admin.sql` 전체를 붙여 넣고 Run.
2. Edge Functions → Deploy a new function → Via Editor. 함수 이름을 **admin-api**로 지정하고 `functions/admin-api/index.ts` 전체로 교체한 뒤 Deploy.
3. admin-api 함수의 설정에서 **Verify JWT with legacy secret**을 끕니다. 이 함수는 별도의 세션 인증을 코드와 SQL 양쪽에서 수행합니다. 공개 로그인·초대 확인 요청이 있으므로 Supabase의 기존 JWT 사전 검증은 사용하지 않습니다. 서비스 키는 브라우저에 보내지 않으며, 함수 실행환경의 SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY / SUPABASE_URL을 사용합니다. 이 변수들이 없는 프로젝트 환경이라면 Supabase의 기본 API 키 설정을 먼저 확인해야 합니다.
4. Authentication의 Sign In / Providers(또는 Providers)에서 **Email 로그인은 활성화**하고 **Allow new users to sign up은 비활성화**합니다. 기존 설정의 Confirm email은 해제할 필요가 없습니다. 가입은 서버의 admin.createUser로만 수행됩니다.
5. SQL Editor 새 쿼리에 `bootstrap.sql` 전체를 붙여 넣고 Run. 결과의 **관리자_비밀번호_설정_링크**를 본인 브라우저에서 열고 이름·비밀번호를 직접 설정합니다. 이 링크를 다른 사람에게 보내거나 GitHub·채팅에 붙여 넣지 않습니다.
6. 사이트 → 관리자 모드 → slowsix로 로그인. 운영자 관리에서 초대 링크를 만들어 직접 전달합니다. 운영자가 가입하면 같은 화면에서 승인합니다.

bootstrap.sql을 다시 실행하면 미사용 이전 관리자 설정 링크는 무효화됩니다. 이미 관리자 계정이 있으면 새 관리자 설정 링크를 만들지 않습니다. 링크 만료 시 계정 생성 전에 다시 실행하면 됩니다.

## 데이터와 인증 구조

기존 사이트 연결은 그대로 두고 관리자 모드만 새 프로젝트를 사용합니다. 기존 데이터는 복사·변경·삭제하지 않습니다.

Supabase Auth는 내부의 무작위 기술용 이메일 식별자를 사용합니다. 사용자에게 이메일을 요구하거나 메일을 발송하지 않습니다. 이 식별자는 비밀 키가 아니며 실제 이메일 주소도 아닙니다. `ss_admin.people`에서 영문 아이디와 Auth 사용자 ID를 연결합니다.

Edge Function에서 Auth 비밀번호를 검증한 뒤 앱용 256비트 난수 세션을 발급합니다. Auth access/refresh token은 클라이언트에 노출하지 않습니다. 앱 세션은 SHA-256 해시만 DB에 보관하며 8시간 후 만료됩니다. 브라우저의 sessionStorage에 세션을 보관하고 로그아웃 시 서버 세션도 제거합니다. 계정 상태는 매 요청마다 DB에서 확인합니다.

데이터 테이블은 비공개 `ss_admin` 스키마에 두고 RLS를 활성화했습니다. anon/authenticated에 테이블·스키마 접근과 RPC 실행 권한을 주지 않습니다. `public.ss_admin_gateway`는 service_role만 호출 가능합니다. 서버 RPC 안에서도 세션과 현재 역할을 확인하므로 요청 본문의 role/status/사용자 ID 위조로 권한을 얻을 수 없습니다. 이 스키마를 Data API의 Exposed schemas에 추가하지 마세요.

정산 항목 금액은 1원 이상 정수입니다. 관리자 수정 시 version을 검사하여 동시 수정 덮어쓰기를 차단합니다. 신규 등록은 request_id로 재시도 중복을 방지합니다. 삭제는 soft delete이며 변경 전후 금액을 audit에 기록합니다.

## 계산과 현재 정책

조회 기간 최대 366일, 목록은 100건씩 표시하고 합계는 기간 전체를 DB에서 계산합니다.

- 총 매출 = 스클 + 계산서 + 현금
- 총 지출 = 고정비 + 일반지출
- 순수익 = 총 매출 - 총 지출
- 운영 수수료 = 순수익 × 5%, 원 단위 반올림
- 정산금액 = 계산서 + 현금 - 일반지출 - 운영 수수료

사용자 미정 항목은 최소한의 초기 정책으로 구현했습니다: 적자에도 같은 식을 적용하고, 음수 수수료·정산에는 안내를 표시합니다. 송금·자동 확정·월 마감·이월은 수행하지 않습니다. 금액 환불은 음수 입력을 지원하지 않으며 필요한 경우 관리자 정정으로 처리합니다.

## 계정 복구

이메일을 수집하지 않아 자동 이메일 복구는 제공하지 않습니다. 비밀번호를 잊은 경우 운영자는 관리자에게 문의하고, 관리자는 Supabase에서 아래 절차로만 복구합니다. 비밀번호를 채팅으로 받거나 기존 비밀번호를 조회하는 기능은 없습니다.

1. `select id, username, auth_email from ss_admin.people;`로 대상 Auth ID를 확인합니다.
2. 해당 Auth 사용자의 비밀번호를 Supabase의 관리자 API(서버 환경)로 재설정해야 합니다. 현재 화면에는 이 기능이 없으므로, 대상 사용자가 새 비밀번호를 직접 설정하는 일회용 복구 링크 기능은 후속 작업입니다.
3. 접근 중지가 필요하면 관리자 화면의 `접근 중지`를 사용합니다. 관리자 본인 계정은 이 화면에서 중지할 수 없습니다.

## 검증 및 제한

`cd tests && npm ci && npm test`.

실제 PostgreSQL 기반 PGlite에서 SQL migration, 일회용 초기 관리자 설정, 승인 대기 차단, 운영자 입력 범위, 계정당 실패 제한, 세션 만료·중지, 직접 API 권한 차단, 집계·동시 수정·감사 기록을 검증합니다. Auth 서비스 호출만 메모리 mock이며, Supabase의 실제 프로젝트 인증·메일 설정·Edge 배포는 사용자 설치 이후 최종 확인해야 합니다.

`node tests/preview.mjs`는 테스트 전용 계정과 가상 정산 내역만 사용하는 localhost 화면 검증 서버입니다. 운영 사이트·DB에는 테스트 데이터를 저장하지 않습니다. 테스트 계정은 실제 계정이 아닙니다.

공식 문서:
- https://supabase.com/docs/guides/functions/quickstart-dashboard
- https://supabase.com/docs/guides/functions/secrets
- https://supabase.com/docs/reference/javascript/auth-admin-createuser
