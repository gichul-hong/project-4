import cv2
import json
import time
import asyncio
import threading
import numpy as np
import websockets
import mediapipe as mp

import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "gesture_engine")))

from one_euro_filter import PointFilter3D
from gesture_classifier import MLPGestureClassifier, rule_based_gesture

# MediaPipe Hands 초기화
mp_hands = mp.solutions.hands
mp_drawing = mp.solutions.drawing_utils

class PythonARClient:
    def __init__(self, host_url="ws://localhost:8000/ws/client_1", client_id="client_1"):
        self.host_url = host_url
        self.client_id = client_id
        self.filter = PointFilter3D(min_cutoff=1.2, beta=0.01)
        
        # 모델 로드 (없으면 룰 기반 fallback)
        model_path = os.path.join(os.path.dirname(__file__), "..", "gesture_engine", "gesture_mlp.pkl")
        self.classifier = MLPGestureClassifier(model_path if os.path.exists(model_path) else None)
        
        self.websocket = None
        self.running = True
        self.prev_x, self.prev_y = 0.5, 0.5

    async def connect_ws(self):
        while self.running:
            try:
                async with websockets.connect(self.host_url) as ws:
                    self.websocket = ws
                    print(f"[✓] Connected to Host WebSocket: {self.host_url}")
                    while self.running:
                        await asyncio.sleep(1)
            except Exception as e:
                print(f"[!] WebSocket Connection error: {e}, Retrying in 2s...")
                await asyncio.sleep(2)

    def run_camera_loop(self):
        cap = cv2.VideoCapture(0)
        if not cap.isOpened():
            print("[!] Cannot open webcam")
            return

        hands = mp_hands.Hands(
            max_num_hands=1,
            min_detection_confidence=0.6,
            min_tracking_confidence=0.6
        )

        prev_time = time.time()
        fps = 0

        print(f"[*] Starting Python AR Client ({self.client_id})... Press 'q' to quit.")

        while self.running and cap.isOpened():
            ret, frame = cap.read()
            if not ret:
                break

            frame = cv2.flip(frame, 1) # 좌우 반전
            h, w, _ = frame.shape
            rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
            results = hands.process(rgb)

            curr_time = time.time()
            fps = 1.0 / max(curr_time - prev_time, 1e-4)
            prev_time = curr_time

            gesture_name = "IDLE"

            if results.multi_hand_landmarks:
                hand_landmarks = results.multi_hand_landmarks[0]
                mp_drawing.draw_landmarks(frame, hand_landmarks, mp_hands.HAND_CONNECTIONS)

                # 3D 랜드마크 추출
                pts_3d = [[lm.x, lm.y, lm.z] for lm in hand_landmarks.landmark]
                
                # 제스처 분류
                _, gesture_name, proba = self.classifier.predict(pts_3d)

                # 1-Euro Filter 적용
                raw_x, raw_y, raw_z = pts_3d[8] # 검지 끝
                fx, fy, fz = self.filter(raw_x, raw_y, raw_z, curr_time)

                dx = fx - self.prev_x
                dy = fy - self.prev_y
                self.prev_x, self.prev_y = fx, fy

                # WebSocket 전송
                if self.websocket and not self.websocket.closed:
                    payload = {
                        "x": float(fx),
                        "y": float(fy),
                        "z": float(fz),
                        "dx": float(dx),
                        "dy": float(dy),
                        "gesture": gesture_name,
                        "confidence": float(proba),
                        "timestamp": curr_time
                    }
                    asyncio.run_coroutine_threadsafe(
                        self.websocket.send(json.dumps(payload)),
                        self.loop
                    )

            # 화면 HUD 오버레이
            cv2.putText(frame, f"{self.client_id.upper()} | FPS: {fps:.1f}", (20, 40),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 100), 2)
            cv2.putText(frame, f"Gesture: {gesture_name}", (20, 80),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 220, 255), 2)
            cv2.putText(frame, "1-Euro Filter: ACTIVE", (20, 115),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (200, 200, 200), 1)

            cv2.imshow(f"AR Air Gesture Client - {self.client_id}", frame)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                self.running = False
                break

        cap.release()
        cv2.destroyAllWindows()

    def start(self):
        self.loop = asyncio.new_event_loop()
        ws_thread = threading.Thread(target=self._run_async_loop, daemon=True)
        ws_thread.start()
        self.run_camera_loop()

    def _run_async_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_until_complete(self.connect_ws())

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="ws://localhost:8000/ws/client_1", help="WebSocket URL")
    parser.add_argument("--id", default="client_1", help="Client ID (client_1 ~ client_4)")
    args = parser.parse_args()

    client = PythonARClient(host_url=args.host, client_id=args.id)
    client.start()
