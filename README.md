/opt/homebrew/Library/Homebrew/cmd/shellenv.sh: line 18: /bin/ps: Operation not permitted
# 실험 노트 GUI · ver3

프로젝트별로 **프로토콜 · 실험 노트 · 메모 · 재고**를 관리하는 웹 앱입니다.  
React SPA + iframe 셸 + Supabase 동기화 구조를 사용합니다.

## 배포

- 웹 앱: https://hkimkr.github.io/experimental-note-gui/
- 저장소: https://github.com/hkimkr/experimental-note-gui

## 실행

로컬 HTTP 서버로 열어주세요 (file:// 은 iframe/postMessage 제한이 있을 수 있습니다).

```bash
cd experimental-note-gui
python3 -m http.server 8080
```

브라우저에서 `http://localhost:8080/index.html` 접속

## 파일

| 파일 | 설명 |
|------|------|
| `index.html` | iframe 셸 + 클라우드 로그인 FAB |
| `app.html` | React SPA (프로토콜/노트/메모/재고) |
| `sync-app.js` | Supabase Realtime 동기화 |
| `supabase/note_records.sql` | DB 스키마 |

## Supabase 설정

`sync-app.js`에 설정된 Supabase 프로젝트를 사용합니다.

1. [Supabase Dashboard](https://supabase.com/dashboard) → SQL Editor
2. `supabase/note_records.sql` 전체 실행 (동기화·프로토콜 공유 테이블 + RLS + RPC + **Realtime** 포함)
3. 앱에서 왼쪽 아래 **클라우드 로그인** → 계정으로 로그인

> 기존 SQL을 실행한 프로젝트도 이메일 기반 프로토콜 공유를 사용하려면 최신 `supabase/note_records.sql` 전체를 다시 실행해야 합니다. 모든 구문은 재실행 가능하게 작성되어 있습니다.

별도 Supabase 프로젝트를 쓰려면 `sync-app.js`의 `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`를 변경하세요.

## 기능

- **프로토콜**: 실험 → 프로토콜 → 단계 그룹 → 시약/반응조건/방법 패널 (가로 배치), 버전 저장, diff 비교, 2단 PDF, 이메일 복사·이동
- **실험 노트**: 날짜/목적, 조건 라벨, 프로토콜 불러오기, 단계 사이 텍스트, 텍스트별 실제 수행 메모·결과 기록
- **실험 메모**: planner 스타일 메모장 + 포스트잇 보드/목록
- **재고 관리**: 5단계 정성 슬라이더 (전부 소진 → 넉넉함)

## 데이터

- localStorage 키: `hamin-exp-note-v1`
- JSON 백업/가져오기: 헤더 우측 버튼

## 릴리스

- `v3.4.0`: 프로토콜 비교 표시 강화, 실험 정리 위치 개선, 실험 노트 단계 overview와 순서 변경, 실험 노트 보기·편집 모드 추가
- `v3.3.0`: Planner 방식 입력 종료 후 동기화, 빈 값보다 내용 우선 병합, 프로토콜 독립 레코드 분리로 영역별 동시 수정 보존, 프로젝트 순서 변경 안정화
- `v3.2.0`: 최신 입력 상태 우선 동기화, 앱 복귀 즉시 재연결, 편집 중인 항목만 원격 반영 보류, 기기 반영 시각 표시
- `v3.1.0`: 빈·오래된 기기의 덮어쓰기 차단, 사용자 편집 의도 기반 동기화, 실험 노트 다중 프로토콜 불러오기와 단계 순서 재배치
- `v2.2.0`: 시약 조제와 시약·조건 패널 텍스트를 입력 완료 후 클릭 가능한 블록으로 표시하고, 빈 PDF가 생성되던 저장 경로 수정
- `v3.0.0`: 프로토콜 보기/편집 모드 분리, 방법·단계·개요·재고 블록 보기, 반응 조건의 rpm을 편집 가능한 비고로 변경
- `v2.1.0`: 최초 연결 시 빈 데이터 덮어쓰기 방지, 프로젝트 내부 항목별 동기화, 시약 Total 소수점 둘째 자리·Sample 제외 합계 추가
- `v2.0.0`: 앱 썸네일·파비콘 통일, 텍스트별 CRITICAL STEP·CAUTION 강조, 실험 노트 편집·기록 버튼 표시 개선
- `v1.0.0`: 첫 공개 배포
