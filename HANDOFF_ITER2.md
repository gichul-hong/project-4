# 🥊 H4CK3RZ 팀 — Iter2 핸드오프 가이드 (AI Agent 연속 개발용)

> **대상**: 이어서 개발할 조원 + AI 코딩 에이전트 (Kilo/Cursor/Copilot 등)  
> **마지막 업데이트**: 2026-08-24 (월)  
> **작업자**: 동규  
> **현재 상태**: iter2 End-to-End 파이프라인 완성 → UI/UX 폴리싱, face-game 연동 필요

---

## 1. 프로젝트 전체 맵

```
C:\hong\project-4\
├── PROJECT_PROPOSALS.md    # 기획서 (아이디어 A·B + 평가 전략 + Day 1~5 타임라인)
├── ref/                    # 참고자료 (DS Vision Board HTML, PPT)
├── iter1/                  # [완료] 다자간 에어 제스처 3D 피라미드 탐사 시스템
│   ├── server/             #   FastAPI + WebSocket + Three.js 피라미드 씬
│   ├── gesture_engine/     #   1-Euro Filter + MLP 제스처 분류기
│   └── client_py/          #   Python 클라이언트 (OpenCV+MediaPipe)
├── iter2/                  # [진행 중] 4인 AR 섀도우 복싱 배틀 아레나
│   ├── server/             #   FastAPI + WebSocket + Three.js 복싱 링
│   │   ├── app.py          #     서버 메인 (ArenaGameManager, WebSocket 처리)
│   │   ├── ssl_helper.py   #     자체 서명 인증서 생성
│   │   └── templates/      #     arena.html (Host 3D 링), fighter_client.html (웹캠 컨트롤러)
│   ├── motion_learning/    #   GPU Bi-LSTM 모션 분류 모델 학습
│   │   ├── motion_lstm.py  #     모델 정의 (2-Layer BiLSTM + Attention, 6클래스)
│   │   ├── train_gpu_motion.py  # 학습 스크립트 + 정적 룰 베이스라인 비교
│   │   ├── synthetic_boxing_data.py # 합성 데이터 생성기
│   │   ├── boxing_lstm.pth #     학습 완료된 가중치
│   │   └── eval_results.json    #  정량 지표 (룰 33.3% → LSTM 100%)
│   ├── run_arena_server.py #   서버 실행 진입점
│   └── run_arena_server.bat    #   Windows 원클릭 실행 배치
└── face-game/              # [신규] 얼굴로 조종하는 슈팅 게임 (별도 데모)
    └── index.html          #   MediaPipe Face Mesh 기반 단일 HTML
```

---

## 2. Iter2 현재 상태 요약

### 2.1 이미 동작하는 것

| 컴포넌트 | 파일 | 확인 여부 |
|---|---|---|
| WebSocket 서버 기동 | `run_arena_server.bat` → `run_arena_server.py` → `app.py` | ✅ |
| 자체 서명 SSL 인증서 | `server/ssl_helper.py` → `cert.pem`, `key.pem` 자동 생성 | ✅ |
| Host 3D 복싱 링 대시보드 | `templates/arena.html` (Three.js + 4인 HP 바) | ✅ |
| 파이터 웹캠 클라이언트 | `templates/fighter_client.html` (MediaPipe Hands + 양손 트래킹) | ✅ |
| GPU 모션 모델 학습 완료 | `motion_learning/boxing_lstm.pth` + `eval_results.json` | ✅ |
| 6종 모션 분류기 | IDLE, JAB_STRAIGHT, LEFT_HOOK, RIGHT_UPPERCUT, TWO_HAND_GUARD, ENERGY_WAVE | ✅ |
| 데미지 시스템 | `ArenaGameManager.process_attack()` — 속도 가산 + 가드 감소 + KO | ✅ |
| 정량 지표 (Show Numbers) | 룰베이스 33.3% → BiLSTM 100% | ✅ |

### 2.2 아직 안 된 것

1. **fighter_client.html에서 실시간 모션 추론 (LSTM)을 브라우저 JS로 직접 돌리지 않고 있다** — 현재는 단순 휴리스틱으로 액션 판별 중. ONNX 변환 후 WebGL 백엔드로 브라우저에서 추론하거나, 서버에서 Python 추론을 대신해줘야 한다.
2. **음향 효과 없음** — 타격음, K.O. 카운트다운, 배경 BGM 미구현.
3. **4인 대전 시 HP/공격이 단순 근접 범위로 적용됨** — 실제로는 3D 공간 좌표 기반 타겟 선택 필요.
4. **게임 종료 조건** — HP가 0이 되어도 자동 리셋 없음. 점수만 올라감.
5. **face-game과 iter2의 통합** — 얼굴 조준 + 복싱 모션의 하이브리드 컨트롤 미구현.
6. **발표 슬라이드 / 시연 스크립트** — 미작성.

---

## 3. 핵심 아키텍처 (AI Agent에게 설명할 것)

### 3.1 데이터 흐름

```
[Fighter 노트북]                    [Host 서버]                      [Observer]
                                         │
   웹캠 → MediaPipe Hands              │                             │
   21개 랜드마크/손 →                │                             │
   휴리스틱 액션 분류 →              │                             │
   WebSocket ────────────→           │                             │
                           JSON {action, velocity, pos_x, pos_z}
                                         │
                                      ArenaGameManager
                                         │
                                      공격 판정 + HP 계산
                                         │
                                      broadcast ─────────────→  arena.html (Three.js 3D)
                                         │                     fighter_client.html (HUD)
                                         │
                                      /api/motion-eval ──────→  eval_results.json
```

### 3.2 WebSocket 메시지 포맷

**클라이언트 → 서버:**
```json
{
  "action": "JAB_STRAIGHT",
  "velocity": 32.5,
  "pos_x": -0.3,
  "pos_z": 0.1
}
```

**서버 → 모든 클라이언트 (broadcast):**
```json
{
  "client_id": "client_1",
  "action": "JAB_STRAIGHT",
  "velocity": 32.5,
  "color": "#FF3366",
  "fighters": { "client_1": {...}, "client_2": {...}, ... },
  "hits": [
    { "target_id": "client_2", "damage": 15, "is_guard": false, "target_hp": 85 }
  ]
}
```

### 3.3 모션 클래스 6종 (데미지 포함)

| 인덱스 | 클래스명 | 데미지 | 트리거 조건 |
|---|---|---|---|
| 0 | IDLE | 0 | 기본 대기 |
| 1 | JAB_STRAIGHT | 12~18 | 손을 앞으로 빠르게 뻗기 |
| 2 | LEFT_HOOK | 18~27 | 왼손을 옆에서 원호로 휘두르기 |
| 3 | RIGHT_UPPERCUT | 25~37 | 오른손을 아래→위로 급상승 |
| 4 | TWO_HAND_GUARD | 0 (방어) | 양 주먹을 얼굴 앞으로 |
| 5 | ENERGY_WAVE | 40~60 | 양손 가슴에서 모았다가 방출 |

---

## 4. AI Agent에게 작업을 시키는 프롬프트 레시피

아래 포맷으로 각 작업을 Agent에게 던지면, 이 문서를 읽은 Agent가 맥락을 이해하고 작업을 이어받을 수 있다.

### 작업 1: fighter_client.html에 실시간 BiLSTM 추론 붙이기

```
C:\hong\project-4\iter2\server\templates\fighter_client.html 에서
현재 휴리스틱으로 액션을 판별하는 부분을 찾고,
motion_learning/motion_lstm.py 의 BiLSTM 모델을 ONNX로 변환한 뒤
브라우저에서 ONNX Runtime Web으로 실시간 추론하도록 수정해줘.

입력: 30프레임 x 63차원 (21개 랜드마크 * 3D 좌표)
출력: 6개 클래스 중 최대 확률 액션

ONNX 변환은 motion_learning/ 폴더에 스크립트를 새로 만들고,
브라우저 추론은 CDN onnxruntime-web을 사용해.
```

### 작업 2: 타격 사운드 이펙트 추가

```
C:\hong\project-4\iter2\server\templates\arena.html 의
WebSocket 메시지 처리 부분에서 hits 정보를 받을 때
Web Audio API로 타격음을 재생하도록 추가해줘.

사운드는 합성음을 쓰고 (발진기 기반),
펀치 타입별로 다른 주파수/길이:
- JAB: 800Hz, 60ms
- HOOK: 300Hz, 100ms
- UPPERCUT: 150Hz, 150ms  
- ENERGY_WAVE: 60Hz sweep → 400Hz, 300ms
- GUARD 성공: 1000Hz, 30ms metalic
- KO: 80Hz road, 500ms
```

### 작업 3: 게임 라운드 시스템 (HP 리셋 + 승리 카운트)

```
C:\hong\project-4\iter2\server\app.py 의 ArenaGameManager에
라운드 시스템을 추가해줘:
- 모든 파이터의 HP를 100으로 리셋하는 reset_round() 메서드
- 한 명이라도 HP=0이면 3초 카운트다운 후 자동 리셋
- 각 파이터별 round_win 카운트 추적 (fighters 딕셔너리에 wins 필드 추가)
- broadcast로 round_start / round_end 이벤트 전송

arena.html에도 라운드 표시와 카운트다운 오버레이를 추가해줘.
```

### 작업 4: 3D 공간 기반 정밀 타겟팅

```
현재 iter2는 모든 상대에게 데미지가 들어간다.
이걸 fighter_client.html에서 전송하는 pos_x, pos_z 좌표를 기준으로
가장 가까운 상대 1명에게만 데미지가 들어가도록 수정해줘.

server/app.py의 process_attack()에서
attacker의 pos와 모든 target의 pos 간 거리를 계산해서
일정 반경(예: 10 units) 이내의 가장 가까운 상대만 타격.
```

### 작업 5: face-game과 복싱 결합 — 얼굴 조준 + 손 공격

```
C:\hong\project-4\face-game\index.html 의 얼굴 추적(MediaPipe Face Mesh)과
iter2의 손 추적(MediaPipe Hands)을 하나의 HTML로 합쳐줘.

- 얼굴 방향 → 3D 아레나에서 바라보는 방향/타겟 지정
- 손 동작 → 공격 액션 (기존 모션 6종)
- 입 벌리기 → 필살기 (ENERGY_WAVE)

새 파일은 iter2/hybrid/ 디렉토리를 만들어서 fighter_hybrid.html 로 저장해줘.
```

---

## 5. 실행 방법 (조원에게 전달)

### 서버 띄우기

```bash
# 방법 1: 원클릭
C:\hong\project-4\iter2\run_arena_server.bat

# 방법 2: 수동
conda activate pjt-4
cd C:\hong\project-4\iter2
python run_arena_server.py --port 8000
```

### 접속 주소

| 역할 | URL |
|---|---|
| Host 3D 링 대시보드 | `https://<서버IP>:8000/arena` |
| Fighter 1 (Red) | `https://<서버IP>:8000/client?id=client_1` |
| Fighter 2 (Cyan) | `https://<서버IP>:8000/client?id=client_2` |
| Fighter 3 (Gold) | `https://<서버IP>:8000/client?id=client_3` |
| Fighter 4 (Green) | `https://<서버IP>:8000/client?id=client_4` |
| 학습 지표 API | `https://<서버IP>:8000/api/motion-eval` |

> **주의**: SSL 자체 서명 인증서이므로 브라우저에서 "고급 → 계속 진행" 클릭 필요

### face-game 실행

```bash
cd C:\hong\project-4\face-game
python -m http.server 8080
# → 브라우저에서 http://localhost:8080
```

---

## 6. Conda 환경 (`pjt-4`)

```bash
conda activate pjt-4
python --version   # 3.12
pip list           # fastapi, uvicorn, websockets, torch, numpy, scikit-learn, opencv-python, mediapipe
```

**의존성 추가 필요 시**:
- `onnx`, `onnxruntime` — 모델 변환
- `jinja2` — 이미 설치됨 (FastAPI 템플릿)

---

## 7. Day 3~4 남은 작업 리스트 (우선순위)

| # | 작업 | 파일 | 예상 시간 | 우선순위 |
|---|---|---|---|---|
| 1 | 휴리스틱 액션 → LSTM 실시간 추론으로 교체 | `fighter_client.html` + ONNX 변환 스크립트 | 2h | 🔴 |
| 2 | 사운드 이펙트 (타격음, KO) | `arena.html` | 1h | 🔴 |
| 3 | 라운드 시스템 (HP 리셋 + 승리) | `app.py` + `arena.html` | 2h | 🟡 |
| 4 | 3D 공간 타겟팅 정밀화 | `app.py` (process_attack) | 1h | 🟡 |
| 5 | face-game + boxing 하이브리드 컨트롤러 | `iter2/hybrid/fighter_hybrid.html` | 3h | 🟢 |
| 6 | 파티클/VFX/카메라 쉐이크 고도화 | `arena.html` | 2h | 🟢 |
| 7 | 발표 슬라이드 제작 | PPT | 2h | 🟡 |
| 8 | 발표 시연 시나리오 + 리허설 | — | 1h | 🔴 |

---

## 8. 디버깅 노트

- **WebSocket 연결 안 될 때**: SSL 인증서 자동 생성 확인 (`server/ssl_helper.py`), 방화벽 8000 포트 개방, `http://`로 fallback 시도 (`--no-ssl` 플래그)
- **MediaPipe Hand 인식이 안정적이지 않을 때**: 조명을 얼굴/손에 고르게 비추기, 배경을 단색으로, 팔이 프레임 안에 들어오게 카메라 거리 조절
- **학습된 LSTM의 eval_results.json이 100%면**: 합성 데이터로 학습해서 과적합 상태일 가능성 있음. 실사용 시 실제 웹캠 데이터로 재학습 필요
- **arena.html Three.js 씬이 안 보일 때**: WebGL 지원 브라우저 확인 (크롬 권장), Three.js CDN 로딩 확인 (개발자 도구 Network 탭)
- **발표장 네트워크**: 반드시 로컬 네트워크/핫스팟으로 구성. Wi-Fi 없는 환경 대비

---

## 9. 팀 컨벤션

- **브랜치**: `iter2-feature-<이름>` 브랜치에서 작업 후 PR
- **커밋**: `[iter2] <영어 요약>` 형식 (예: `[iter2] add LSTM inference to fighter client`)
- **HTTP 포트**: 8000 고정
- **파이썬 환경**: `conda activate pjt-4` 로 통일
- **정적 파일**: 이미지/음원은 `server/static/` 에 넣고 `/static/파일명` 으로 접근