# 🥊 Iter2 개발/변경 이력 (DEVLOG)

> **프로젝트**: 4인 실시간 AR 섀도우 복싱 & 배틀 아레나
> **최종 갱신**: 2026-08-24 (월) 22:15
> **작성 규칙**: 최신 변경이 위. 각 항목은 `날짜 — 변경 내용 / 이유 / 영향 범위` 형식.

---

## 2026-08-24 (월) — 야간 대규모 리팩터링

### [22:15] 타격 사거리 현실화 튜닝
- **원인**: 디버깅용으로 사거리를 25 units까지 늘렸더니 링 반대편에서도 주먹이 닿는 문제.
- **해결**: 서버 로그에서 실제 전투 거리(6~10 units)를 확인 후 적절 값으로 조정.
- **현재 값**:
  - 잽/크로스/훅: **10 units** (가까이 다가가야 타격)
  - 어퍼컷: **8 units** (더 근접 필요)
  - 장풍(ENERGY_WAVE): **30 units** (원거리 스킬)
  - dot threshold: 0.2~0.3 (약 ±72~78도)
- 영향: `server/app.py` `process_attack()`

### [22:00] 타격 판정 디버그 로그 추가 + 펀치 감지 완화
- **서버 로그**: 공격 패킷 수신 시 `[RECV]`, 각 타겟별 거리/각도/OK/MISS `[ATK]`, 실제 HIT `[HIT]` 로그 출력. 쿨다운 차단도 `[ATK] BLOCKED` 로그.
- **클라이언트 펀치 threshold**: 20 km/h → **12 km/h** (더 쉽게 펀치 감지)
- **쿨다운**: 클라이언트 400ms → **350ms**, 서버 0.4s → **0.3s**
- 영향: `server/app.py`, `fighter_client.html`

### [21:30] Arena 아바타 이동 버그 원인 발견 — client_id 오타 방어
- **원인**: 사용자가 URL에 `client?id=clinet_1` (오타)로 접속 → 서버의 `fighters` dict에 없는 키 → arena에서 `fighterMeshes["clinet_1"]` 미존재 → 패킷 무시 → 아바타 부동.
- **해결**: 서버에서 유효하지 않은 client_id(`client_1`~`client_4` 외)로 접속 시 자동으로 `/client?id=client_1`로 리다이렉트.
- **추가**: arena WebSocket에 `onopen`/`onerror`/`onclose` 핸들러 추가 → combat log에 연결 상태 표시.
- 영향: `server/app.py`, `arena.html`

### [21:00] Arena WebSocket 연결 디버그 + null guard 강화
- arena `onmessage`에서 `data.client_id`가 없는 패킷(game_state 이벤트) 처리 시 `if (!cid) return;` 추가.
- `data.action`이 undefined일 때 기본값 `"IDLE"` 적용.
- yaw 보간에 각도 wrap-around 처리 추가 (`[-π, π]` 정규화).
- 영향: `arena.html`

### [20:30] fighter_client.html 전면 재작성 (FPS + 이동 버그 근본 해결)
- **근본 원인 3가지 해결**:
  1. **FPS 30 문제**: 두 개의 `requestAnimationFrame` 루프 (drawCamCanvas + animate)가 프레임을 분할 → **단일 rAF 루프로 통합**. 캔버스 드로잉은 50ms throttle (20fps).
  2. **주먹만 이동, 본체 고정**: MediaPipe Pose가 실패 시 `poseDetected=true` 고정 → Hands lean 폴백 비활성화 → `leanX/Y=0` → 이동 없음. → **Pose 완전 제거**, Hands 손목 중점 lean만 사용하여 항상 이동 가능.
  3. **앞/뒤 기울임 반전**: MediaPipe 좌표계에서 앞으로 숙이면 cy 증가 → leanY 부호 반전 필요. → `leanY = (cy - neutralY)` 로 수정.
- **기타 변경**:
  - WASD 키 제거, **화살표 키만** 유지 (`e.code` 기반: `ArrowUp/Down/Left/Right`)
  - MediaPipe Hands 주기: 50ms(20fps) → **80ms(~12fps)** — GPU 부하 감소
  - 글러브 SphereGeometry segments: 16 → **12** — 렌더 부하 감소
  - 디버그 HUD: lean 값, calibration 상태, hands 감지 개수, neutral 값, 실제 moveXZ, rotation 모두 표시
- 영향: `fighter_client.html` (전면 재작성)

### [19:00] 서버 성능 최적화 (app.py)
- **`enforce_collision()` 쓰로틀링**: 매 WebSocket 메시지(40+/sec)마다 실행하던 충돌 체크를 `time.monotonic()` 기반 **50ms 간격**(초당 20회)으로 제한. `enforce_collision_throttled()` 메서드 추가.
- **불필요한 broadcast 스킵**: 위치(world_x/z/yaw를 round(2)로 비교)가 변경되지 않은 IDLE 패킷은 broadcast 하지 않음. 공격 패킷, hit 결과, collision correction은 무조건 broadcast.
- **서버 초기 yaw 값 수정**: 클라이언트 `fighterStartConfigs`의 yaw와 일치하도록 수정 (`client_1: -1.5708` 등).
- 영향: `server/app.py`

### [18:30] Arena 뷰 FPS 개선 (arena.html)
- **`playWhoosh()` AudioBuffer 캐시**: 매 호출마다 `createBuffer()`로 새 AudioBuffer를 생성하던 것을 `whooshBuffer` 변수에 캐시하여 재사용 (fighter_client과 동일 패턴). GC 부하 감소.
- **Camera shake 드리프트 방지**: `controls.target`에 랜덤 변위를 누적하던 것을 `shakeDuration === 0` 시 `controls.target.set(0, 0, 0)`으로 원점 복귀. 장시간 플레이 시 카메라 중심점 드리프트 해소.
- 영향: `arena.html`

---

## 2026-08-24 (월) — 후반 작업

### [15:45] 관절형 휴머노이드 캐릭터 도입
- **변경**: 기존 단순 프리미티브(원통 몸통 + 구 머리 + 구 글러브) 아바타를 **관절형 휴머노이드**로 교체.
- **새 파일**: `server/static/humanoid.js` (전역 `window.createHumanoid(color)` 팩토리)
  - 관절 계층: 어깨/팔꿈치(팔), 고관절/무릎(다리), 목, 몸통, 머리, 글러브, 가드 실드
  - 절차적 애니메이션: 호흡 바운스 + 이동 보행 스윙 + 펀치(앞으로 뻗기) + 가드(팔 올리기) 포즈를 lerp로 자동 보간
  - `setAction(action)` / `update()` API. 기존 필드(`group, head, body, leftGlove, rightGlove, shield`) 호환 유지
- **영향**: `arena.html`, `fighter_client.html` 양쪽 아바타 생성부를 humanoid로 교체. 펀치 광선은 글러브 월드 좌표에서 발사하도록 변경. `fighterConfigs`에 `name` 추가(승자 표시 버그 해소).
- **참고**: 포즈 수치(어깨/팔꿈치 각도)는 1차 튜닝값. 화면에서 어색하면 `humanoid.js`의 `POSES` 블록만 조정.

### [15:20] client view 원경 시점 전환
- 좌측 웹캠: `object-fit: cover` → `contain` (전체 프레임 축소 표시, 잘림 제거)
- 우측 1인칭 링: FOV 50→68, 카메라 오프셋 `(0, 0.6, 5.5)` 추가로 어깨 너머 원경감 확보
- 영향: `fighter_client.html` CSS/카메라 초기화부

### [15:05] 근접 타격 데미지 미적용 수정
- **원인**: `process_attack()`의 정면 방향 조건(`dot > 0.3`)이 너무 엄격해 얼굴이 약간만 틀어져도 공격 무효화.
- **해결**: 근접(거리 < 6)이면 방향 무시하고 무조건 타격, 원거리(6~18)는 정면 60도 이내(`dot > 0.5`)만 타격.
- 영향: `server/app.py` `process_attack()`

### [14:50] HP=0 이후 타격 불가 처리
- 공격자 HP가 0이면 공격 자체를 무시(`None` 반환)
- 타겟 탐색 루프에서 HP 0인 파이터 제외
- 영향: `server/app.py`

### [14:30] arena 실시간 렌더링 동기화 개선
- WebSocket `onmessage`에서 메쉬 위치를 직접 lerp하던 구조 → 목표 좌표를 `targetStates` 버퍼에만 저장하고 `animate()` 60FPS 루프에서 보간하도록 분리
- Camera Shake가 OrbitControls와 충돌하지 않게 `controls.update()` 이후 오프셋 적용 방식으로 변경
- `stat-fps` DOM 미존재로 인한 초당 JS 에러도 방어
- 영향: `arena.html`

---

## 2026-08-24 (월) — 초반 작업 (동규)

- `iter2/` 서버·학습 베이스라인 구축 (`app.py`, `run_arena_server.py/.bat`, `motion_learning/`)
- GPU BiLSTM 학습 완료 (`boxing_lstm.pth`, `eval_results.json`: 룰 33.3% → LSTM 100%)
- `arena.html`(Host 3D 링) / `fighter_client.html`(파이터 웹캠 클라이언트) 골격 완성
- 데미지 시스템(`process_attack`), 0.4초 쿨다운, 가드 감소, KO 점수 부여

---

## 📌 얼굴 사진 → 3D 머리 대체 — 타당성 검토 (2026-08-24)

**결론: 가능하지만 "실시간 브라우저"와 "5일" 제약 안에서 3단계 접근을 권장.**

### 요구사항 정리
- 선수 얼굴 사진 몇 장 → 3D 머리로 렌더링 → 아레나/클라이언트 아바타 머리 교체
- 목표: "얼굴이 진짜 그 사람처럼 보이는 3D"

### 옵션 A — 사진을 텍스처로 입힌 구형/박스 머리 (1~2시간, 저난이도) ★추천
- 얼굴 사진을 `THREE.TextureLoader`로 로드해 머리 구(sphere) 또는 직육면체의 **정면 텍스처**로 매핑.
- 현재 `humanoid.js`의 `head`(구)만 텍스처 입힌 구로 교체하면 됨.
- **장점**: 브라우저에서 즉시 동작, 무설치, 5일 안에 확실히 완료.
- **단점**: 정면만 정확하고 측면/뒤가 왜곡됨(2.5D 수준). 완전한 3D 얼굴은 아님.

### 옵션 B — 사진 → FLAME/DECA 3D 얼굴 재구성 → GLB로 내보내기 (1~2일, 고난이도)
- 오프라인 Python에서 DECA(또는 MICA/FLAME)로 단일/다중 사진 → 3D 얼굴 메쉬 + 텍스처 + 표정/립싱 파라미터 복원.
- 결과를 `.glb`로 export → `THREE.GLTFLoader`로 로드해 humanoid `head` 대체.
- **장점**: 진짜 3D 얼굴, CV 과제(단안 3D 복원)로서 **Show Numbers/창의성** 어필 가능. 회전/측면도 자연스러움.
- **단점**: GPU/Python 환경 필요, 사진 정합·조명 보정·GLB 크기 최적화로 시간 리스크 큼. 삼성 사내 적용 시 FLAME 계열 라이선스(MIT/연구용 혼재) 확인 필요.

### 옵션 C — 정면/측면 사진 → 사진 기반 빌보드 + 머리 매핑 하이브리드
- 정면/후면/측면 사진을 받아 머리에 다중 뷰 텍스처 매핑하거나, 카메라를 마주보는 스프라이트 면.
- A보다 낫지만 B보다 못한 중간. 단순성 대비 이득이 크지 않음.

### 권장
- **이번 발표용은 옵션 A로 즉시 확보**하고, 시간이 남으면 옵션 B(DECA 단안 3D 복원)를 **"차별화 포인트 + Show Numbers"**로 추가.
- 옵션 A 구현 포인트: `humanoid.js`에 `setHeadTexture(url)` API 추가 → `TextureLoader`로 구 머리 `MeshStandardMaterial.map` 설정 → 서버 `static/faces/`에 사진 배치.
- 사진 저작권/초상권: 팀원 얼굴은 본인 동의 확보, 외부 인물은 사용 금지.

---

## ⏭️ 다음 작업 후보 (우선순위)

1. **얼굴 텍스처(옵션 A)** — `humanoid.js` 머리에 사진 매핑 + `/api/faces` 또는 static 업로드 경로 (1~2h)
2. **LSTM 실시간 추론 연동** — 현재 클라이언트는 휴리스틱. ONNX 변환 + `onnxruntime-web` (2~3h)
3. **라운드 시스템** — HP=0 시 리셋/승리 카운트 (`app.py` + `arena.html`) (2h)
4. **사운드 고도화** — 타격/가드/KO 음향 (1h)
5. **발표 슬라이드 + 시연 시나리오** (2h)
6. **포즈 튜닝** — `humanoid.js` `POSES` 값 미세 조정 (브라우저 확인 후)

---

## 🐞 알려진 이슈 / 주의

- **디버그 로그**: `app.py`의 `process_attack`에 `[ATK]`/`[HIT]`/`[RECV]` print가 남아 있음. 발표 전 제거 권장.
- **arena console.log**: `arena.html`의 `[WS]` console.log 디버그 로그 잔존. 발표 전 제거 권장.
- **client_id 오타 방어**: 서버에서 유효하지 않은 id를 `client_1`로 리다이렉트하지만, WebSocket 경로(`/ws/{client_id}`)는 방어 미적용. 직접 WebSocket URL을 잘못 입력하면 여전히 문제.
- **합성 데이터 100% 정확도**: 이상적인 합성 데이터 기반 수치. 발표 시 "이상적 조건"임을 명시하거나 실웹캠 데이터 보완 필요.
- **MediaPipe Pose 제거됨**: 현재 client는 Hands 손목 중점만으로 lean 감지. Pose 대비 정밀도가 낮지만 FPS 안정성이 크게 향상됨. 필요 시 Pose를 다시 추가하되 타임아웃 폴백 필수.
- **humanoid 포즈**: 1차 튜닝값이라 어색할 수 있음. 브라우저에서 확인 후 `POSES` 조정.
