# Rule-base 판정 로직 명세 (다이어그램 제작용)

> 대상 코드: [`server/templates/fighter_client.html`](./server/templates/fighter_client.html) (런타임 단일 소스),
> [`server/static/punch_core.js`](./server/static/punch_core.js) (펀치 트리거+분류 단일 소스),
> 참고 재구현: [`eval/evaluate_full_actions.py`](./eval/evaluate_full_actions.py)
>
> **이 문서의 용도**: 발표자료에 들어갈 흐름도/트리 다이어그램을 다른 에이전트가 그대로
> 그릴 수 있도록, 판정 로직을 "노드(조건/상태) + 엣지(분기)" 단위로 분해해 둔 명세다.
> 각 절의 코드 블록은 실제 소스의 조건문 순서를 그대로 의사코드로 옮긴 것이므로,
> 코드 블록 하나 = 흐름도 한 장(또는 트리 한 그루)으로 변환하면 된다.
>
> **핵심 전제 — 모든 판정은 상대좌표다.** 절대 픽셀 좌표나 절대 거리를 쓰는 조건은
> 하나도 없다. 모든 길이는 "어깨폭"으로 나눠 배수(倍數)로 표현하고, 모든 위치는
> "어깨 중점(shoulder midpoint)" 또는 "중립 자세(캘리브레이션 값)" 대비 편차로 표현한다.
> 카메라 거리·사람 체형·해상도가 달라져도 같은 임계값이 통하게 하기 위함이다.

---

## 0. 입력 — 사용하는 랜드마크

MediaPipe Pose 33개 랜드마크 중 상체 **7개 노드**만 사용한다.

| 노드 | 인덱스 | 이 문서에서의 기호 |
| :--- | :---: | :--- |
| 코 (NOSE) | 0 | `nose` |
| 왼쪽 어깨 | 11 | `lsh` |
| 오른쪽 어깨 | 12 | `rsh` |
| 왼쪽 팔꿈치 | 13 | `lel` |
| 오른쪽 팔꿈치 | 14 | `rel` |
| 왼쪽 손목 | 15 | `lwr` |
| 오른쪽 손목 | 16 | `rwr` |

두 가지 좌표계를 함께 쓴다 — **용도가 다르다**:

- **화면 정규화 2D 좌표** (`x,y` ∈ [0,1], MediaPipe `poseLandmarks`) → 이동/회전/가드처럼
  "화면에서 몸이 어디로 기울었는가"를 보는 판정에 사용.
- **월드 3D 좌표(미터, 골반 원점)** (`poseWorldLandmarks`) → 펀치처럼 "팔이 실제로 얼마나
  빠르게, 얼마나 뻗었는가"를 보는 판정에 사용 (정면 펀치는 화면 2D로는 팔이 짧아 보여
  뻗음을 구분할 수 없기 때문).

---

## 1. 상대좌표 정규화 — 모든 판정의 공통 전처리

### 1-1. 길이 단위: 어깨폭

```
scale        = max(hypot(lsh.x - rsh.x, lsh.y - rsh.y), 0.06)   # 순간 어깨폭 (2D)
sScale       = EMA(scale, τ_up=0.12s if scale > sScale else τ_down=0.45s)   # 평활 어깨폭
uScale       = max(sScale, 0.06)                                # 길이 단위로 쓰는 값
```

- **비대칭 시상수**가 핵심 규칙: 어깨폭이 **커질 때는 빠르게(0.12초)**, **작아질 때는
  느리게(0.45초)** 따라간다. 몸통을 돌리는 동작(펀치·회전)은 투영 어깨폭을 "줄이기만"
  하므로, 이 비대칭이 회전으로 인한 어깨폭 오염만 골라서 걸러낸다.
- 순간값이 아니라 **평활된 uScale**을 모든 상하좌우 위치의 분모로 쓴다. 순간 어깨폭을
  쓰면 몸통 회전 시 분모 자체가 흔들려 얼굴·주먹 비율까지 부풀려진다.

### 1-2. 중립 자세 캘리브레이션 (기준 원점)

접속 직후 `CALIB_MS = 1800ms` 동안(최소 10프레임) EMA로 기록. **`C` 키로 언제든 재실행.**

```
neutral.roll, neutral.faceRel, neutral.fistRel,
neutral.shMidY, neutral.scale, neutral.lwrOff, neutral.rwrOff
  ← EMA(해당 원시값, α=1.0 첫 프레임 / 0.2 이후)
ready = (경과시간 ≥ 1800ms) AND (누적 프레임 ≥ 10)
```

이후 모든 판정은 **"지금 값 − neutral 값"**, 즉 **중립 자세 대비 편차**로 계산한다.
→ 사람마다 다른 "기본 자세"(어깨가 원래 살짝 기울어진 사람 등)를 원점으로 흡수한다.

### 1-3. 상대좌표 특징값 정의

| 기호 | 정의 | 의미 |
| :--- | :--- | :--- |
| `rollRaw` | `atan2(lsh.y - rsh.y, \|lsh.x - rsh.x\|)` (도) | 어깨선 기울기. +면 왼쪽 어깨가 내려감 |
| `faceRel` | `(nose.y - shMidY) / uScale` | 어깨선 대비 얼굴 높이(어깨폭 배수) |
| `fistRel` | `(wrMidY - shMidY) / uScale` | 어깨선 대비 양 손목 중점 높이 |
| `lwrOff` / `rwrOff` | `(lwr.x - shMidX) / uScale` 등 | 어깨 중점 대비 손목의 좌우 위치 |
| `reachN` | `dist3D(wrist, shoulder) / w_sh` | 어깨→손목 3D 거리(어깨폭 배수) — 펀치 전용 |

`shMidX/Y`는 두 어깨 좌표의 중점. `w_sh`는 3D 월드좌표 기준 어깨폭.

**전부 "어깨폭 배수" 또는 "어깨 중점/중립값 대비 편차"로만 표현된다 — 절대좌표가 등장하는 지점이 없다.**

---

## 2. 프레임별 전체 처리 순서 (최상위 흐름도)

한 프레임의 포즈가 들어올 때마다 아래 순서로 실행된다. **이 순서 자체가 최상위
흐름도의 뼈대**다.

```
[포즈 랜드마크 입력]
      │
      ▼
① 어깨폭(scale) 계산 + 비대칭 평활(sScale)
      │
      ▼
② 중립 캘리브레이션 미완료? ──Yes──▶ 캘리브레이션 누적만 하고 종료
      │No
      ▼
③ 듀얼가드(Guard) 판정  ← §3
      │
      ▼
④ 펀치 락(Lock) 상태 조회  ← §6  (직전 프레임까지의 펀치 이력으로 결정)
      │
      ├─ Locked ──▶ ⑤a 자세 신호(roll/pitch/shift) 갱신 "동결" — 직전 값 유지
      │
      └─ Unlocked ▶ ⑤b 자세 신호(roll/pitch/shift) 갱신 (가드 상태가 pitch 가중치에 반영)
      │
      ▼
⑥ 펀치 트리거·분류 (팔별 독립, 좌/우 동시 진행)  ← §4
      │  (핵심 신호 armed/peak/reach 갱신 → 트리거되면 lastPunchAny 갱신 → 다음 프레임 ④에 반영)
      ▼
⑦ Locked?
      ├─ Yes ──▶ 이동 상태 = 잠금 직전 상태 유지(감쇠) / 회전 상태 = NONE 강제  ← §6
      └─ No  ──▶ 이동(FORWARD/BACK/LEFT/RIGHT) 상태 갱신  ← §5-A
                  회전(ROT_LEFT/ROT_RIGHT) 상태 갱신      ← §5-B
      ▼
[이번 프레임 출력: move, rot, guard, punches[], intensity]
```

> **읽는 법**: ③④⑤⑥⑦은 서로 데이터를 주고받는다 — 가드 상태(③)가 ⑤의 가중치를 바꾸고,
> 펀치 발동(⑥)이 다음 프레임의 락(④)을 만들고, 락(④)이 ⑤⑦ 전체를 동결시킨다.
> 다이어그램에서는 이 4개 모듈을 "서로 화살표로 연결된 상자"로 그리고, 각 상자 내부를
> 아래 §3~§6의 트리로 확장하는 2단 구조를 권장한다.

---

## 3. 듀얼가드(DUAL_GUARD) 판정

```
IF  wristOK (양 손목이 보임)
AND lwr.y < shMidY + 0.15·scale        # 왼손목이 "어깨선 + 어깨폭 15%"보다 위
AND rwr.y < shMidY + 0.15·scale        # 오른손목도 동일
AND dist2D(lwr, nose)/scale < 1.0      # 왼손목이 코에서 어깨폭 1배 이내
AND dist2D(rwr, nose)/scale < 1.0      # 오른손목도 동일
  → guardNow = TRUE
ELSE
  → guardNow = FALSE

# 유지시간 히스테리시스 (오검출 방지)
IF guardNow == FALSE:        guardSince = 0
ELIF guardSince == 0:        guardSince = now   # 상승 엣지 시각 기록
guardActive = (guardSince > 0) AND (now - guardSince ≥ GUARD_HOLD_MS=160ms)
```

- 4개 조건이 **모두 AND**로 묶인 단순 리프 노드 — 트리 없이 다이아몬드 하나로 표현 가능.
- `guardActive`는 §5-A(이동 판정)의 pitch 가중치(`wFace`/`wFist`)를 바꾸는 **분기 조건으로도 재사용**된다 → 다이어그램에서 이 값을 이동 모듈로 향하는 화살표로 표시할 것.

---

## 4. 펀치 — 트리거(발동) → 분류(종류) 2단 구조

> 발표 포인트: "**트리거**(지금 펀치가 나가는 순간인가)"와 "**분류**(어떤 종류인가)"는
> 완전히 분리된 두 개의 결정이다. 왼팔/오른팔에 대해 **각각 독립적으로** 동시에 돌아간다.

### 4-1. 팔 운동학 (매 프레임, 좌우 각각)

```
reach  = dist3D(wrist, shoulder)                # 미터
reachN = reach / w_sh                           # 어깨폭 배수 ★상대좌표
elbow  = angle(shoulder, elbow, wrist)           # 팔꿈치 내각(도), 180=완전히 폄
vx,vy,vz = (wrist - 직전프레임 wrist) / dt        # 손목 속도(m/s)
speed  = |v|
dReach = (reach - 직전프레임 reach) / dt          # 뻗음 증가율(m/s)
```

### 4-2. 트리거 상태 머신 (창 래치, arm → window → fire)

이것이 **펀치 판정의 핵심 상태 머신**이며, 팔마다 `armed / armT / peak / reach0` 4개
상태값을 갖는 유한 상태 기계다.

```
상태: IDLE ──(조건A)──▶ ARMED(창 열림) ──(시간초과)──▶ IDLE
                              │
                     (매 프레임 peak = max(peak, speed) 갱신)
                              │
                        (조건B: 발사 조건)
                              ▼
                        FIRE → 종류분류(§4-3) → IDLE (쿨다운 타이머 세팅)

[조건A] 창 열기 (armed==false 일 때만 검사)
   speed > PUNCH_ARM(1.0 m/s)  AND  dReach > PUNCH_EXTEND(0.40 m/s)
   → armed=true, armT=now, peak=0, reach0=reachN

[창 유효시간] now - armT > PUNCH_WINDOW(380ms) → armed=false (창 닫힘, 실패)

[조건B] 발사 (창이 열려 있는 동안 매 프레임 검사)
   peak ≥ PUNCH_SPEED(1.6 m/s)
   AND ( reachN ≥ PUNCH_REACH_N(0.88)  OR  (reachN - reach0) ≥ PUNCH_GROW_N(0.28) )
   AND (now - lastPunch[같은팔] ≥ PUNCH_CD(400ms))
   AND (now - lastPunchAny[양팔공통] ≥ PUNCH_CD_ANY(200ms))
   → FIRE (armed=false, 종류분류 실행, lastPunch/lastPunchAny 갱신)
```

> **왜 "창"인가**: 속도 최고점과 최대 뻗음이 같은 프레임에 오지 않는다(뻗는 중엔 아직
> 안 뻗었고, 다 뻗으면 이미 감속). 그래서 조건A로 창을 연 뒤 380ms 동안 **최고 속도와
> 그 순간의 궤적방향·팔꿈치각도를 계속 기록**해 두었다가, 뻗음 조건(B)이 채워지는
> 시점에 "그 창 안에서 있었던 최고 속도 순간"의 데이터로 발사·분류한다.

### 4-3. 종류 분류 트리 (발사 순간, 우선순위 있는 3지 분기)

발사 시점의 `peak`(그 창 안 최고속도)와 **그 순간의** `pvx, pvy, pelbow`로 판정한다.
**우선순위: 어퍼컷 → 훅 → 스트레이트** (먼저 걸리는 조건이 이긴다).

```
s = max(peak, 1e-3)
upRatio = -pvy / s     # 위로 솟구치는 성분 비율 (월드좌표 +y=아래이므로 음수 vy가 "위")
hkRatio = |pvx| / s    # 옆으로 휘두르는 성분 비율

IF   upRatio > UPPERCUT_VY(0.55)  AND  pelbow < UPPERCUT_ELBOW(150°)
        → UPPERCUT
ELIF hkRatio > HOOK_VX(0.56)      AND  pelbow < HOOK_ELBOW(158°)
        → HOOK
ELSE
        → STRAIGHT

action = { L: {STRAIGHT:LEFT_JAB,  HOOK:LEFT_HOOK,  UPPERCUT:LEFT_UPPERCUT},
           R: {STRAIGHT:RIGHT_CROSS, HOOK:RIGHT_HOOK, UPPERCUT:RIGHT_UPPERCUT} }[side][종류]
```

- 두 조건 모두 **속도 방향 성분(vx/vy 비율)** 과 **팔꿈치 각도**를 AND로 요구한다 —
  "팔을 편 채(각도↑) 빠르게 찌르면" 방향 성분이 있어도 스트레이트로 남는다
  (훅·어퍼는 "팔을 접은 채" 쳐야만 걸리도록 설계됨).
- 다이어그램 표현: 위 3지 분기를 **이진 결정 트리**(if-elif-else)로 그리면 된다.
  루트 노드 = "upRatio > 0.55 AND elbow<150?" → No 분기에서 다시 "hkRatio > 0.56 AND elbow<158?"

### 4-4. 필살기(ENERGY_WAVE) — 별도의 정적 자세 트리 + 유지시간

트리거와 무관한 **독립된 판정**. 속도를 요구하지 않는 "정적 자세 유지" 방식이다.

```
lWristUpN = (nose.y - lwr.y) / w_sh   # 손목이 코보다 위인 정도 (양수=위)
rWristUpN = (nose.y - rwr.y) / w_sh

up       = lWristUpN > ULT_HANDS_UP_N(0.28)  AND  rWristUpN > ULT_HANDS_UP_N(0.28)
extended = reachN[L] > ULT_REACH_N(0.72)     AND  reachN[R] > ULT_REACH_N(0.72)

IF NOT (up AND extended):
    gatherT = 0   # 자세 풀림 → 타이머 리셋
    → 미발동
ELSE:
    IF gatherT == 0: gatherT = now       # 자세 진입 시각 기록
    IF now - gatherT < ULT_HOLD_MS(350ms): → 미발동 (게이지 표시 진행중 0~100%)
    ELSE: → FIRE(ENERGY_WAVE), gatherT=0, lastFire=now
```

부가 조건: `canUse`(분노 게이지 100%) 및 `now - lastFire ≥ ULT_CD(1500ms)`가 최상위 게이트로 먼저 체크된다(게이지가 없으면 트리 진입 자체가 막힘).

---

## 5. 이동(Footwork) · 회전 — 두 개의 독립 상태 머신

> **전제 조건 규칙 하나가 두 상태 머신을 가른다**: "어깨선이 평행한가"(`|sRoll| < ROLL_FLAT`).
> 평행이 아니면(=몸을 좌우로 기울이는 중) → 좌/우 스텝으로만 해석되고 전진/후진·회전은 아예 후보에 들지 못한다.
> 평행이면 → 전진/후진과 회전을 각각 별도로 검사한다(둘은 동시에 성립 가능 — "숙이며 회전"이 되는 이유).

### 5-A. 이동 상태 후보 결정 트리 (좌/우 우선)

```
rollOn = (현재상태 ∈ {LEFT,RIGHT}) ? ROLL_OFF(7°) : ROLL_ON(12°)   # 상태별 히스테리시스

IF   sRoll >  rollOn:  mCand = LEFT
ELIF sRoll < -rollOn:  mCand = RIGHT
ELIF |sRoll| < ROLL_FLAT(8°):                      # 어깨 평행 구간 → 전/후진 검사
        fwdOn  = (현재상태==FORWARD) ? PITCH_OFF(0.065)      : PITCH_ON(0.105)
        backOn = (현재상태==BACK)    ? PITCH_BACK_OFF(0.115) : PITCH_BACK_ON(0.175)
        IF   sPitch >  fwdOn:  mCand = FORWARD
        ELIF sPitch < -backOn: mCand = BACK
        ELSE:                  mCand = NONE
ELSE:   # 8°~12° 사이의 회색지대 — 평행도 기울임도 아님
        mCand = (현재상태 ∈ {FORWARD,BACK}) ? 현재상태 : NONE   # 흔들지 않고 유지
```

- **1차 분기**: `|sRoll|`이 12°(진입)/7°(해제) 임계를 넘는가 → 좌/우.
- **2차 분기**: 넘지 않고 8° 미만(평행)이면 → pitch로 전/후진 재분기.
- **3차 구간(8~12°)**: 판정 불가 회색지대 — 새 상태를 만들지 않고 "이전이 전/후진이었다면 유지"라는 **관성 규칙**이 있다(다이어그램에서 놓치기 쉬운 분기이므로 별도 박스로 표시 권장).

`sRoll`, `sPitch`는 §1-3 원시값을 **중립 대비 편차 → EMA(τ=0.11s)** 로 평활한 값. `sPitch` 자체는 아래 식으로 합성된다(방향 결정과 증폭을 분리):

```
faceDrop = faceRel - neutral.faceRel     # 방향을 정하는 유일한 항(가중치 큼)
fistDrop = fistRel - neutral.fistRel     # 〃 (보조)
wFace = guardActive ? 0.70 : 0.45
wFist = guardActive ? 0.00 : 0.25
dirCore = wFace·faceDrop + wFist·fistDrop        # ★방향은 이 항만으로 결정
conf = clamp01(|dirCore| / 0.05)                 # 방향이 확실한 정도(0~1)
back = dirCore < 0

bodyDrop  = (shMidY - neutral.shMidY) / uScale        # 상체가 화면에서 내려간 정도(대칭 신호)
nearDelta = (sScale - neutral.scale) / neutral.scale  # 카메라에 가까워진 정도(대칭 신호)

nearAligned = ( (nearDelta<0) == back ) ? 1.20·nearDelta : 0   # 부호가 dirCore와 맞을 때만
bodyAligned = back ? 0 : 0.30·max(0, bodyDrop)                 # 전진 쪽으로만 가산

pitchRaw = dirCore + conf·(nearAligned + bodyAligned)
sPitch  += (pitchRaw - sPitch) · (1 - exp(-dt/0.11))            # EMA
```

> **왜 이렇게 나누나**: `dirCore`(얼굴·주먹의 상하 이동)만 방향을 정하고, 나머지 두 항은
> "방향이 이미 확실할 때(conf) + 부호가 같을 때"만 증폭에 참여한다. 상체 하강은
> 앞으로 숙이든 뒤로 젖히든 똑같이 일어나는 **대칭 신호**라 방향을 못 정하므로 증폭 전용,
> 어깨폭(카메라 거리)은 몸통 회전만으로도 줄어들 수 있어 방향이 맞을 때만 신뢰한다.

### 5-B. 회전 상태 후보 결정 트리

```
IF |sRoll| < ROLL_FLAT(8°):                       # 어깨 평행 — 이동과 같은 전제조건
    sOn = (현재회전상태 != NONE) ? SHIFT_OFF(0.24) : SHIFT_ON(0.40)
    IF   sShift >  sOn:  rCand = ROT_LEFT
    ELIF sShift < -sOn:  rCand = ROT_RIGHT
    ELSE:                rCand = NONE
ELSE:
    rCand = NONE   # 어깨가 기울어져 있으면 회전 후보 자체가 없음
```

`sShift`는 "양 손목이 **같은 방향으로 함께** 움직였는가"를 먼저 검사한 뒤에만 값이 생긴다(펀치는 한쪽 팔만 빠르므로 이 조건이 회전과 펀치를 구분한다):

```
dL = lwrOff - neutral.lwrOff,  dR = rwrOff - neutral.rwrOff
coherent = (dL>0 AND dR>0) OR (dL<0 AND dR<0)              # 두 손목이 같은 방향
           AND min(|dL|,|dR|) > SHIFT_ON·0.45               # 둘 다 충분히 움직임
shiftRaw = coherent ? (dL+dR)/2 : 0
sShift  += (shiftRaw - sShift) · EMA(τ=0.11s)
```

### 5-C. 후보 → 확정 상태 (공통 히스테리시스 메커니즘)

이동·회전 후보(mCand/rCand) 모두 아래의 **같은 확정 규칙**을 통과해야 실제 상태가 된다.

```
function vote(candidate, 현재상태, now):
    IF candidate != 직전candidate:
        직전candidate = candidate; since = now        # 후보가 바뀌면 타이머 리셋

    need = (candidate == NONE) ? HOLD_OFF_MS(100ms) : HOLD_ON_MS(110ms)

    IF immediate(=FAST_RATIO 조건 만족) AND candidate != NONE:
        return candidate   # 확실한 신호는 유지시간 없이 즉시 확정

    return (now - since ≥ need) ? candidate : 현재상태   # 유지시간 못 채우면 이전 상태 유지
```

- **즉시 확정 경로(`FAST_RATIO=1.7`)**: 후보값이 진입 임계값의 1.7배를 넘으면(예: `|sRoll| > 12°×1.7 = 20.4°`) 유지시간을 기다리지 않고 그 프레임에 바로 확정한다. "확실한 동작은 즉시, 애매한 동작만 유지시간으로 걸러낸다"는 설계.
- 이 `vote()` 함수는 이동(mCand)과 회전(rCand)에 각각 독립적으로 적용된다 → 다이어그램에서는 "공통 서브루틴 박스"로 한 번만 그리고 양쪽에서 화살표로 참조하는 형태를 권장.

### 5-D. 강도(intensity) 계산 — 임계값 초과분의 선형 비례

```
IF   move == LEFT or RIGHT:  mi = clamp01((|sRoll|  - ROLL_OFF)       / ROLL_RANGE(16))
ELIF move == FORWARD:        mi = clamp01((sPitch   - PITCH_OFF)      / PITCH_RANGE(0.22))
ELIF move == BACK:           mi = clamp01((-sPitch  - PITCH_BACK_OFF) / PITCH_BACK_RANGE(0.24))
ELSE:                        mi = 0

IF move != NONE: mi = max(mi, MOVE_MIN_INTENSITY=0.38)   # 확정되면 최소 강도 보장
moveIntensity = 즉시확정이었다면 max(moveIntensity, mi)
                아니면 EMA(mi, τ=0.07s)
```
회전 강도(`ri`)도 `SHIFT_OFF/SHIFT_RANGE` 기준으로 동일한 형태.

---

## 6. 펀치 락(Lock) — 두 상태 머신을 동결시키는 상위 규칙

펀치가 몸통 회전·주먹 이동을 동반해 roll/pitch/shift 신호를 크게 흔들기 때문에,
발동 직후 일정 시간 **자세 신호 자체의 갱신을 얼린다.**

```
isLocked(now):
    sincePunch = now - lastPunchAny
    IF sincePunch < PUNCH_LOCK(180ms):
        return TRUE                                     # 최소 잠금 — 무조건 얼림
    armsBusy = max(L.lastSpeed, R.lastSpeed) > 0.9
            OR max(L.lastReachN, R.lastReachN) > 1.00     # 팔이 아직 나가 있는가
    return sincePunch < PUNCH_LOCK_MAX(1100ms) AND armsBusy   # 연장 잠금

IF isLocked:
    ├─ roll/pitch/shift EMA 갱신 자체를 건너뜀 (직전 값 유지)
    ├─ 잠금 진입 "직전" 프레임의 이동상태를 lockedMove에 저장해 두었다가
    │    move = lockedMove.state 로 고정,  intensity ×= exp(-dt/1.2s)  (서서히 감쇠만)
    └─ rot = NONE 강제 (완전 차단 — 주먹 좌우 이동=회전 신호라 펀치와 정면충돌)
ELSE:
    §5의 이동·회전 상태 머신을 정상 실행
```

> **왜 "동결"이지 "차단"이 아닌가**: 예전엔 잠금 중 이동을 완전히 지웠으나, 실제 연타
> 간격(0.20~0.30초)이 잠금 하한(옛 480ms)보다 짧아 **잠금이 한 번도 안 풀려 이동이
> 영구히 불가능**해지는 회귀가 있었다. 그래서 "펀치 이전에 이미 확정돼 있던 이동 의사"는
> 죽이지 않고 그대로 유지(감쇠만)시키는 것으로 바뀌었다 — 잠금 로직 자체가 **한 번의
> 버그 수정 이력을 반영한 규칙**이라는 점은 발표에서 설계 근거로 언급할 만하다.

---

## 7. 다이어그램 제작 가이드 (에이전트 작업 지시용 요약)

| 그릴 다이어그램 | 소스 절 | 권장 형태 |
| :--- | :--- | :--- |
| 전체 파이프라인 한 장 | §2 | 상단→하단 플로우차트, 4개 모듈 상자(가드/락/펀치/이동·회전)를 화살표로 연결 |
| 펀치 트리거 상태머신 | §4-2 | State Diagram (IDLE ⇄ ARMED → FIRE), 창(window) 개념은 타임라인 바 형태 병기 |
| 펀치 종류 분류 | §4-3 | 이진 결정 트리 3단(어퍼컷?→훅?→스트레이트) |
| 이동 상태 결정 | §5-A | 이진 결정 트리 4단(좌?→우?→평행구간(전/후진 하위트리)→회색지대) |
| 회전 상태 결정 | §5-B | 이진 결정 트리 2단(평행조건→좌/우) + coherent 게이트를 선행 조건 박스로 |
| 히스테리시스 공통 로직 | §5-C | 작은 서브루틴 박스 하나로 그려 이동·회전 다이어그램에서 공유 참조 |
| 펀치 락과의 상호작용 | §6 | 전체 파이프라인 다이어그램 위에 "락 ON일 때 우회 경로(bypass)"를 점선 화살표로 표시 |

**색상/강조 제안**: 상대좌표 정규화(§1) 박스는 모든 모듈의 공통 입력이므로 최상단에
한 번만 두고 나머지 모듈에서 화살표로 참조하는 편이 다이어그램이 덜 복잡해진다.
임계값(threshold) 숫자는 각 결정 노드 옆에 작은 라벨로 병기할 것 — 발표에서
"왜 이 값인가"라는 질문에 즉답할 수 있는 근거가 된다(예: 후진 임계가 전진보다
낮은 이유는 §5-A 상단 표 참고).

---

## 8. 임계값 전체 목록 (부록 — fighter_client.html `TUNE` 기준, 상대좌표 단위)

| 상수 | 값 | 단위/의미 |
| :--- | ---: | :--- |
| `ROLL_ON` / `ROLL_OFF` | 12° / 7° | 좌우 스텝 진입/해제 (어깨선 기울기) |
| `ROLL_FLAT` | 8° | "어깨 평행" 상한 — 전/후진·회전의 전제조건 |
| `ROLL_RANGE` | 16° | 강도 계산 분모 |
| `PITCH_ON` / `PITCH_OFF` | 0.105 / 0.065 | 전진 진입/해제 (어깨폭 배수 점수) |
| `PITCH_BACK_ON` / `PITCH_BACK_OFF` | 0.175 / 0.115 | 후진 진입/해제 |
| `SHIFT_ON` / `SHIFT_OFF` | 0.40 / 0.24 | 회전 진입/해제 (손목 좌우 이동, 어깨폭 배수) |
| `HOLD_ON_MS` / `HOLD_OFF_MS` | 110ms / 100ms | 상태 확정에 필요한 최소 유지시간 |
| `FAST_RATIO` | 1.7배 | 이 배수를 넘으면 유지시간 없이 즉시 확정 |
| `MOVE_MIN_INTENSITY` | 0.38 | 확정 상태의 최소 강도 보장치 |
| `GUARD_HOLD_MS` | 160ms | 가드 확정 유지시간 |
| `CALIB_MS` | 1800ms | 중립 자세 캘리브레이션 시간 |
| `SCALE_TAU_UP` / `SCALE_TAU_DOWN` | 0.12s / 0.45s | 어깨폭 추종 시상수(비대칭) |
| `PUNCH_ARM` / `PUNCH_EXTEND` | 1.0 m/s / 0.40 m/s | 펀치 창 열기 조건 |
| `PUNCH_SPEED` / `PUNCH_REACH_N` / `PUNCH_GROW_N` | 1.6 m/s / 0.88 / 0.28 | 펀치 발사 조건 |
| `PUNCH_WINDOW` | 380ms | 창 유효 시간 |
| `PUNCH_CD` / `PUNCH_CD_ANY` | 400ms / 200ms | 같은팔/양팔 쿨다운 |
| `UPPERCUT_VY` / `UPPERCUT_ELBOW` | 0.55 / 150° | 어퍼컷 분류 조건 |
| `HOOK_VX` / `HOOK_ELBOW` | 0.56 / 158° | 훅 분류 조건 |
| `PUNCH_LOCK` / `PUNCH_LOCK_MAX` | 180ms / 1100ms | 자세 신호 동결 최소/최대 시간 |
| `ULT_HANDS_UP_N` / `ULT_REACH_N` | 0.28 / 0.72 | 필살기 자세 조건(어깨폭 배수) |
| `ULT_HOLD_MS` / `ULT_CD` | 350ms / 1500ms | 필살기 유지시간/쿨다운 |

> 참고: `eval/evaluate_full_actions.py`의 `TUNE` 딕셔너리는 일부 값(`ROLL_OFF=8°`,
> `PITCH_ON=0.16` 등)이 위 런타임 값과 **어긋나 있다** — 오프라인 평가기가 별도로
> 유지되던 옛 값이 남은 것으로, `FOOTWORK_EVAL_PLAN.md`에도 기록된 알려진 이슈다.
> 발표에는 이 문서의 §8 값(=런타임 `fighter_client.html` 실제 값)을 기준으로 삼을 것.
