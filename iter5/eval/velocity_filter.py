"""velocity_filter.py — 손목 3D 궤적의 속도 추정을 안정화하는 신호처리 필터.

evaluate_video.py 의 arm_kinematics() 는 손목 위치의 단순 유한차분(Δ손목/Δt)으로
속도를 구한다. MediaPipe world landmark 는 프레임마다 수 mm 단위 진동(jitter)이
있어서, 미분이 이 고주파 노이즈를 증폭시킨다 → 비펀치 구간의 속도 스파이크(FP)와
피크 찢어짐(FN). 이 모듈은 궤적을 먼저 스무딩한 뒤 속도를 내는 두 필터를 제공한다.

  - KalmanVelocityFilter : 등속(constant-velocity) 모델 1차원 칼만 × 3축.
      위치만 관측하고, process noise(q)는 미지의 가속도를, measurement noise(r)는
      landmark jitter 를 나타낸다. r 을 landmark visibility 로 조절하면(Phase 3)
      가려짐에 견고해진다. 오프라인 평가와 런타임 모두 온라인(스트리밍) 호환.
  - SavitzkyGolayFilter : causal(과거만) 2차 다항식 피팅. 창(window) 만큼의 과거
      프레임으로 현재 위치를 추정해, 칼만보다 지연이 적은 대신 노이즈 억제는 약하다.

둘 다 첫 프레임(또는 dt<=0)에서는 위치를 그대로 통과시키고 속도 0 으로 시작한다.
"""
from __future__ import annotations

import numpy as np


class KalmanVelocityFilter:
    """3축 독립 등속 1D 칼만 필터.

    state: [px, vx, py, vy, pz, vz]
    관측: 위치 3축만. 속도는 필터가 내부에서 추정한다.
    """

    def __init__(self, q: float = 1e-2, r: float = 1e-3):
        # q: process noise (미지 가속도의 불확실성, m^2/s^4 오더)
        # r: measurement noise (landmark 위치 jitter 분산, m^2 오더)
        self.q = float(q)
        self.r = float(r)
        self.x: np.ndarray | None = None
        self.P: np.ndarray | None = None

    def reset(self):
        self.x = None
        self.P = None

    def update(self, px: float, py: float, pz: float, dt: float):
        z = np.array([px, py, pz], dtype=np.float64)
        if self.x is None or dt <= 0:
            self.x = np.zeros(6, dtype=np.float64)
            self.x[0] = px
            self.x[2] = py
            self.x[4] = pz
            self.P = np.eye(6, dtype=np.float64)
            return px, py, pz

        # 상태 전이 (등속)
        F = np.eye(6, dtype=np.float64)
        F[0, 1] = dt
        F[2, 3] = dt
        F[4, 5] = dt

        # process noise Q: 가속도 항이 속도 성분에만 기여
        G = np.zeros((6, 3), dtype=np.float64)
        G[1, 0] = dt
        G[3, 1] = dt
        G[5, 2] = dt
        Q = self.q * (G @ G.T)

        # measurement H: 위치만
        H = np.zeros((3, 6), dtype=np.float64)
        H[0, 0] = 1.0
        H[1, 2] = 1.0
        H[2, 4] = 1.0
        R = self.r * np.eye(3, dtype=np.float64)

        # predict
        x_pred = F @ self.x
        P_pred = F @ self.P @ F.T + Q

        # update
        y = z - H @ x_pred
        S = H @ P_pred @ H.T + R
        K = P_pred @ H.T @ np.linalg.inv(S)
        self.x = x_pred + K @ y
        self.P = (np.eye(6) - K @ H) @ P_pred

        return self.x[0], self.x[2], self.x[4]


class SavitzkyGolayFilter:
    """causal(과거만) Savitzky-Golay 2차 다항식 피팅으로 현재 위치를 추정한다.

    과거 window 개 프레임에 2차 다항식을 최소제곱 피팅하고, 마지막 시점(현재)의
    피팅 값을 취한다. 순수 과거만 쓰므로 온라인에서 지연이 생기지 않는다.
    """

    def __init__(self, window: int = 5):
        self.window = max(5, int(window))
        self.buf: list[tuple[float, float, float]] = []

    def reset(self):
        self.buf = []

    def update(self, px: float, py: float, pz: float, dt: float):
        del dt  # 등간격 가정 (evaluate_video 는 ~33ms 고정)
        self.buf.append((px, py, pz))
        if len(self.buf) > self.window:
            self.buf.pop(0)
        n = len(self.buf)
        if n < 3:
            return px, py, pz

        t = np.arange(n, dtype=np.float64)
        A = np.vstack([t * t, t, np.ones(n)]).T  # (n, 3)
        pts = np.array(self.buf, dtype=np.float64)  # (n, 3)
        coef, *_ = np.linalg.lstsq(A, pts, rcond=None)  # (3, 3)
        tt = float(n - 1)
        return (
            coef[0, 0] * tt * tt + coef[1, 0] * tt + coef[2, 0],
            coef[0, 1] * tt * tt + coef[1, 1] * tt + coef[2, 1],
            coef[0, 2] * tt * tt + coef[1, 2] * tt + coef[2, 2],
        )


def make_filter(kind: str | None, q: float = 1e-2, r: float = 1e-3,
                window: int = 5):
    """kind 에 맞는 필터를 생성한다. None 이면 필터 없음(None)을 반환."""
    if not kind:
        return None
    if kind == "kalman":
        return KalmanVelocityFilter(q=q, r=r)
    if kind == "savitzky_golay":
        return SavitzkyGolayFilter(window=window)
    raise ValueError(f"unknown velocity filter kind: {kind}")
