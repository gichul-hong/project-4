"""
rule_baseline.py — 현재 punch_core.js 의 rule-base 판정 로직을 10-클래스 전체 라벨 체계로
그대로 이식한 Python 버전. TCN과 "같은 실측 데이터, 같은 LOSO 분할"로 비교하기 위한 기준선이다.

punch_core.js 에서 그대로 가져온 부분:
  - classify(k): -vy/speed > UPPERCUT_VY && elbow 충분히 굽음  → UPPERCUT
                  |vx|/speed > HOOK_VX && elbow 충분히 굽음     → HOOK
                  그 외                                          → STRAIGHT(JAB)
  (punch_core.js 는 "어느 팔이 펀치를 냈는지"는 애초에 알고 시작하지만,
   여기서는 그 정보가 없으므로 최고 속도가 나온 팔을 active arm으로 판정한다)

punch_core.js 에 없어서 새로 정의한 부분 (GUARD/IDLE/ENERGY_WAVE):
  - GUARD:  양 손목이 서로 가깝고 팔꿈치도 모임 (fighter_client.html 의 거리 기반 가드 판정과 같은 발상)
  - IDLE:   전체 구간 손목 속도가 낮음
  - ENERGY_WAVE: 양손이 "동시에" 강하게 뻗음 (현재 게임엔 아예 구현이 없는 동작이라 새로 정의)
  - OTHER 를 위한 명시적 규칙은 없다 — 지금의 rule-base 시스템도 "정체불명 동작"을 걸러내는
    개념이 없기 때문에(항상 무언가로 분류), 이 한계를 그대로 재현한다.

임계값은 heuristic_7j_v1 값 분포를 한 번 훑어 사람이 정한 것으로, 실제 PUNCH_TUNE이
하니스 실측으로 튜닝된 것과 같은 성격의 "고정 규칙"이다 (fold별로 다시 맞추지 않는다).
"""
import numpy as np

HAND_DIST_GUARD = 0.85
ELBOW_DIST_GUARD = 1.55
IDLE_SPEED_MAX = 11.0
WAVE_MIN_SPEED = 18.0
WAVE_BALANCE_RATIO = 0.80
UPPERCUT_VY = 0.55
UPPERCUT_ELBOW_RATIO = 0.85
HOOK_VX = 0.56
HOOK_ELBOW_RATIO = 0.90

# heuristic_7j_v1 열 인덱스
L_ELBOW, R_ELBOW = 0, 1
L_VX, L_VY, L_VZ, R_VX, R_VY, R_VZ = 4, 5, 6, 7, 8, 9
L_SPEED, R_SPEED = 10, 11
HANDS_DIST, ELBOW_DIST = 12, 15


def classify_heuristic_sequence(heur_seq):
    """heur_seq: (T, 17) ndarray → 예측 라벨 문자열"""
    hd_last = heur_seq[-8:, HANDS_DIST].mean()
    ed_last = heur_seq[-8:, ELBOW_DIST].mean()
    max_l = heur_seq[:, L_SPEED].max()
    max_r = heur_seq[:, R_SPEED].max()
    overall_max = max(max_l, max_r)
    min_max = min(max_l, max_r)

    if hd_last < HAND_DIST_GUARD and ed_last < ELBOW_DIST_GUARD:
        return "TWO_HAND_GUARD"

    if overall_max < IDLE_SPEED_MAX:
        return "IDLE"

    if min_max > WAVE_MIN_SPEED and (min_max / overall_max) > WAVE_BALANCE_RATIO:
        return "ENERGY_WAVE"

    # 단일 팔 펀치 종류 판별 — punch_core.js classify() 이식
    side = "L" if max_l >= max_r else "R"
    if side == "L":
        peak_idx = int(np.argmax(heur_seq[:, L_SPEED]))
        vx, vy, speed, elbow = heur_seq[peak_idx, [L_VX, L_VY, L_SPEED, L_ELBOW]]
    else:
        peak_idx = int(np.argmax(heur_seq[:, R_SPEED]))
        vx, vy, speed, elbow = heur_seq[peak_idx, [R_VX, R_VY, R_SPEED, R_ELBOW]]

    s = max(speed, 1e-3)
    if (-vy / s) > UPPERCUT_VY and elbow < UPPERCUT_ELBOW_RATIO:
        kind = "UPPERCUT"
    elif (abs(vx) / s) > HOOK_VX and elbow < HOOK_ELBOW_RATIO:
        kind = "HOOK"
    else:
        kind = "JAB"

    return f"{'LEFT' if side == 'L' else 'RIGHT'}_{kind}"


def evaluate_rule_baseline(heuristic_seqs, label_names):
    preds = [classify_heuristic_sequence(seq) for seq in heuristic_seqs]
    correct = sum(p == t for p, t in zip(preds, label_names))
    acc = correct / len(label_names) if label_names else 0.0
    return acc, preds
