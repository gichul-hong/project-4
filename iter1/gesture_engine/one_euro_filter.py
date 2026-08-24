import math
import time

class LowPassFilter:
    def __init__(self, alpha=0.5):
        self.alpha = alpha
        self.hat_x_prev = None

    def __call__(self, x, alpha=None):
        if alpha is not None:
            self.alpha = alpha
        if self.hat_x_prev is None:
            self.hat_x_prev = x
            return x
        hat_x = self.alpha * x + (1.0 - self.alpha) * self.hat_x_prev
        self.hat_x_prev = hat_x
        return hat_x

    def reset(self):
        self.hat_x_prev = None


class OneEuroFilter:
    """
    1-Euro Filter: 노이즈/손떨림(Jittering)을 제거하면서도 빠른 동작 시 지연(Lag)을 최소화하는 적응형 저주파 필터
    """
    def __init__(self, min_cutoff=1.0, beta=0.007, d_cutoff=1.0):
        self.min_cutoff = float(min_cutoff)
        self.beta = float(beta)
        self.d_cutoff = float(d_cutoff)
        self.x_filter = LowPassFilter()
        self.dx_filter = LowPassFilter()
        self.t_prev = None

    def alpha(self, cutoff, dt):
        tau = 1.0 / (2.0 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, x, timestamp=None):
        if timestamp is None:
            timestamp = time.time()
        if self.t_prev is None:
            self.t_prev = timestamp
            return self.x_filter(x, 1.0)

        dt = max(timestamp - self.t_prev, 1e-4)
        self.t_prev = timestamp

        # 변화율(속도) 계산 및 필터링
        dx = (x - (self.x_filter.hat_x_prev if self.x_filter.hat_x_prev is not None else x)) / dt
        edx = self.dx_filter(dx, self.alpha(self.d_cutoff, dt))

        # 속도에 따라 cutoff frequency를 동적으로 조절
        cutoff = self.min_cutoff + self.beta * abs(edx)
        return self.x_filter(x, self.alpha(cutoff, dt))

    def reset(self):
        self.x_filter.reset()
        self.dx_filter.reset()
        self.t_prev = None


class PointFilter3D:
    """3차원 좌표 (X, Y, Z)에 대한 1-Euro 필터 래퍼"""
    def __init__(self, min_cutoff=1.0, beta=0.007, d_cutoff=1.0):
        self.fx = OneEuroFilter(min_cutoff, beta, d_cutoff)
        self.fy = OneEuroFilter(min_cutoff, beta, d_cutoff)
        self.fz = OneEuroFilter(min_cutoff, beta, d_cutoff)

    def __call__(self, x, y, z=0.0, timestamp=None):
        return (
            self.fx(x, timestamp),
            self.fy(y, timestamp),
            self.fz(z, timestamp)
        )

    def reset(self):
        self.fx.reset()
        self.fy.reset()
        self.fz.reset()
