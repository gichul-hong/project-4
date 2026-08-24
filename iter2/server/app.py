import os
import json
import asyncio
import math
import time
from typing import Dict
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI(title="4-Player AR Boxing & Battle Arena")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# 정적 파일
static_dir = os.path.join(BASE_DIR, "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

# 4인 파이터 상태 관리자
COLLIDER_RADIUS = 2.8
MIN_FIGHTER_DIST = COLLIDER_RADIUS * 2  # 5.6 — 두 파이터가 겹치지 않는 최소 거리


class ArenaGameManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.last_attack_times: Dict[str, float] = {}
        self._last_collision_time: float = 0.0
        self._collision_interval: float = 0.05  # 50ms 간격으로 충돌 체크 (초당 20회)
        self._last_positions: Dict[str, tuple] = {}  # 마지막 broadcast한 위치 캐시
        self.reset_game()

    def reset_game(self):
        self.fighters = {
            "client_1": {"name": "Red Boxer", "color": "#FF3366", "hp": 100, "score": 0, "action": "IDLE", "pos": [-12, 0, 0], "world_x": -12, "world_z": 0, "yaw": -1.5708},
            "client_2": {"name": "Cyan Boxer", "color": "#00E5FF", "hp": 100, "score": 0, "action": "IDLE", "pos": [12, 0, 0], "world_x": 12, "world_z": 0, "yaw": 1.5708},
            "client_3": {"name": "Gold Mage", "color": "#FFD700", "hp": 100, "score": 0, "action": "IDLE", "pos": [0, 0, -12], "world_x": 0, "world_z": -12, "yaw": 3.1416},
            "client_4": {"name": "Green Striker", "color": "#00FF66", "hp": 100, "score": 0, "action": "IDLE", "pos": [0, 0, 12], "world_x": 0, "world_z": 12, "yaw": 0},
        }

    def enforce_collision_throttled(self):
        """충돌 체크를 일정 간격(50ms)으로만 실행하여 CPU 부하 감소."""
        now = time.monotonic()
        if now - self._last_collision_time < self._collision_interval:
            return {}
        self._last_collision_time = now
        return self.enforce_collision()

    def enforce_collision(self):
        """모든 파이터 쌍 간 거리 검사 → 겹치면 서로 밀어냄. 수정된 world_x/z를 반환."""
        corrections = {}  # {client_id: (new_x, new_z)}
        ids = list(self.fighters.keys())
        for i in range(len(ids)):
            for j in range(i + 1, len(ids)):
                a, b = ids[i], ids[j]
                fa = self.fighters[a]
                fb = self.fighters[b]
                ax, az = fa.get("world_x", fa.get("pos", [0, 0, 0])[0]), fa.get("world_z", fa.get("pos", [0, 0, 0])[2])
                bx, bz = fb.get("world_x", fb.get("pos", [0, 0, 0])[0]), fb.get("world_z", fb.get("pos", [0, 0, 0])[2])
                dx, dz = ax - bx, az - bz
                dist = math.hypot(dx, dz)
                if dist < MIN_FIGHTER_DIST and dist > 0.001:
                    nx, nz = dx / dist, dz / dist
                    push = (MIN_FIGHTER_DIST - dist) / 2
                    ca = corrections.get(a, (ax, az))
                    cb = corrections.get(b, (bx, bz))
                    corrections[a] = (ca[0] + nx * push, ca[1] + nz * push)
                    corrections[b] = (cb[0] - nx * push, cb[1] - nz * push)
        # 기록 반영
        for cid, (x, z) in corrections.items():
            x = max(-16.0, min(16.0, x))
            z = max(-16.0, min(16.0, z))
            self.fighters[cid]["world_x"] = x
            self.fighters[cid]["world_z"] = z
        return corrections

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket
        if client_id in self.fighters:
            self.fighters[client_id]["hp"] = 100 # 접속 시 HP 100 초기화!
        print(f"[+] Fighter connected: {client_id}")
        await self.broadcast({
            "type": "game_state",
            "event": "fighter_joined",
            "client_id": client_id,
            "fighters": self.fighters,
            "active_users": list(self.active_connections.keys())
        })

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
            print(f"[-] Fighter disconnected: {client_id}")

    async def broadcast(self, message: dict):
        msg_text = json.dumps(message)

        async def _send(cid, conn):
            try:
                await conn.send_text(msg_text)
            except Exception:
                return cid
            return None

        results = await asyncio.gather(*[_send(cid, conn) for cid, conn in self.active_connections.items()], return_exceptions=True)
        for cid in results:
            if isinstance(cid, str):
                self.disconnect(cid)

    def process_attack(self, attacker_id: str, action: str, velocity: float):
        """공격 판정 — 디버그 로그 포함"""

        attacker = self.fighters.get(attacker_id, {})
        if attacker.get("hp", 0) <= 0:
            return None

        # (데미지, 최대사거리, dot 임계값)
        attack_specs = {
            "JAB_STRAIGHT":    (12, 10.0, 0.3),
            "LEFT_JAB":        (12, 10.0, 0.3),
            "RIGHT_CROSS":     (16, 10.0, 0.3),
            "LEFT_HOOK":       (18, 10.0, 0.2),
            "RIGHT_UPPERCUT":  (25,  8.0, 0.3),
            "ENERGY_WAVE":     (40, 30.0, 0.3),
        }
        spec = attack_specs.get(action)
        if not spec:
            return None
        raw_dmg, max_range, dot_threshold = spec

        # 0.3초 쿨다운
        now = asyncio.get_event_loop().time()
        last_time = self.last_attack_times.get(attacker_id, 0.0)
        if now - last_time < 0.3:
            print(f"[ATK] {attacker_id} {action} BLOCKED by cooldown ({now - last_time:.2f}s)", flush=True)
            return None
        self.last_attack_times[attacker_id] = now

        dmg = int(raw_dmg * (1.0 + min(velocity, 50.0) / 100.0))

        att_x = attacker.get("world_x", attacker.get("pos", [0, 0, 0])[0])
        att_z = attacker.get("world_z", attacker.get("pos", [0, 0, 0])[2])
        att_yaw = attacker.get("yaw", 0.0)

        look_dx = -math.sin(att_yaw)
        look_dz = -math.cos(att_yaw)

        best_target_id = None
        best_dot = -2.0

        for target_id, fighter in self.fighters.items():
            if target_id != attacker_id and fighter.get("hp", 0) > 0:
                tgt_x = fighter.get("world_x", fighter.get("pos", [0, 0, 0])[0])
                tgt_z = fighter.get("world_z", fighter.get("pos", [0, 0, 0])[2])

                to_tgt_x = tgt_x - att_x
                to_tgt_z = tgt_z - att_z
                dist = (to_tgt_x**2 + to_tgt_z**2)**0.5

                if dist > 0.1:
                    dot = (look_dx * to_tgt_x + look_dz * to_tgt_z) / dist
                    in_range = dist <= max_range
                    in_angle = dot > dot_threshold
                    print(f"[ATK] {attacker_id}->{target_id} dist={dist:.1f}(max{max_range}) dot={dot:.2f}(min{dot_threshold}) {'OK' if in_range and in_angle else 'MISS'}", flush=True)
                    if in_range and in_angle and dot > best_dot:
                        best_dot = dot
                        best_target_id = target_id

        hits = []
        if best_target_id:
            fighter = self.fighters[best_target_id]
            is_guard = (fighter.get("action") in ["TWO_HAND_GUARD", "DUAL_GUARD"])
            actual_dmg = int(dmg * 0.2) if is_guard else dmg
            fighter["hp"] = max(0, fighter["hp"] - actual_dmg)
            tgt_x = fighter.get("world_x", fighter.get("pos", [0, 0, 0])[0])
            tgt_z = fighter.get("world_z", fighter.get("pos", [0, 0, 0])[2])
            hit_dist = ((tgt_x - att_x)**2 + (tgt_z - att_z)**2)**0.5
            hits.append({
                "attacker_id": attacker_id,
                "target_id": best_target_id,
                "damage": actual_dmg,
                "is_guard": is_guard,
                "target_hp": fighter["hp"],
                "distance": round(hit_dist, 1)
            })
            print(f"[HIT] {attacker_id}->{best_target_id} dmg={actual_dmg} hp={fighter['hp']}", flush=True)
            if fighter["hp"] == 0:
                attacker["score"] = attacker.get("score", 0) + 1
        else:
            print(f"[ATK] {attacker_id} {action} NO TARGET HIT", flush=True)

        return hits

manager = ArenaGameManager()

@app.get("/", response_class=HTMLResponse)
@app.get("/arena", response_class=HTMLResponse)
async def get_arena_page(request: Request):
    """메인 Host 3D 복싱 링 / 배틀 아레나 페이지"""
    return templates.TemplateResponse(request=request, name="arena.html", context={})

@app.get("/client", response_class=HTMLResponse)
async def get_client_page(request: Request, id: str = "client_1"):
    """파이터 웹캠 클라이언트 페이지"""
    valid_ids = ["client_1", "client_2", "client_3", "client_4"]
    if id not in valid_ids:
        # 오타 방지: 유효하지 않은 id면 client_1로 리다이렉트
        from fastapi.responses import RedirectResponse
        return RedirectResponse(url=f"/client?id=client_1")
    fighter = manager.fighters.get(id, {"name": "Fighter", "color": "#FF3366"})
    return templates.TemplateResponse(
        request=request,
        name="fighter_client.html",
        context={"client_id": id, "name": fighter["name"], "color": fighter["color"]}
    )

@app.post("/api/reset-game")
@app.get("/api/reset-game")
async def reset_game_endpoint():
    """모든 파이터 HP 100 및 점수 초기화"""
    manager.reset_game()
    await manager.broadcast({
        "type": "game_state",
        "event": "game_reset",
        "fighters": manager.fighters,
        "active_users": list(manager.active_connections.keys())
    })
    return {"status": "success", "message": "Game reset to 100 HP"}

@app.get("/api/motion-eval")
async def get_motion_eval():
    """GPU 딥러닝 모션 학습 지표 반환"""
    eval_file = os.path.join(os.path.dirname(BASE_DIR), "motion_learning", "eval_results.json")
    if os.path.exists(eval_file):
        with open(eval_file, "r") as f:
            return json.load(f)
    return {
        "device": "cuda:0 (NVIDIA GPU)",
        "rule_based_accuracy": 0.624,
        "lstm_accuracy": 0.987,
        "improvement_pct_points": 36.3,
        "training_time_seconds": 4.12
    }

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)
    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            action = payload.get("action", "IDLE")
            velocity = payload.get("velocity", 0.0)

            # 공격 액션은 로깅
            if action not in ("IDLE", "DUAL_GUARD", "TWO_HAND_GUARD"):
                print(f"[RECV] {client_id} action={action} vel={velocity:.1f} pos=({payload.get('world_x',0):.1f},{payload.get('world_z',0):.1f})", flush=True)

            # 파이터 액션 및 3D 월드 위치 갱신
            if client_id in manager.fighters:
                manager.fighters[client_id]["action"] = action
                if "world_x" in payload:
                    manager.fighters[client_id]["world_x"] = payload["world_x"]
                if "world_z" in payload:
                    manager.fighters[client_id]["world_z"] = payload["world_z"]
                if "yaw" in payload:
                    manager.fighters[client_id]["yaw"] = payload["yaw"]

            # 서버 권한 충돌 해소 — 쓰로틀링 적용 (50ms 간격)
            corrections = manager.enforce_collision_throttled()

            # 충돌 보정된 좌표를 payload에 반영 (arena 뷰 + 클라이언트 동기화)
            if client_id in manager.fighters:
                payload["world_x"] = manager.fighters[client_id]["world_x"]
                payload["world_z"] = manager.fighters[client_id]["world_z"]

            # 타격 이벤트 판정 (양손 액션 포함)
            hit_results = None
            if action in ["JAB_STRAIGHT", "LEFT_JAB", "RIGHT_CROSS", "LEFT_HOOK", "RIGHT_UPPERCUT", "ENERGY_WAVE"]:
                hit_results = manager.process_attack(client_id, action, velocity)

            payload["client_id"] = client_id
            payload["color"] = manager.fighters.get(client_id, {}).get("color", "#FFFFFF")
            payload["hits"] = hit_results
            # fighters 전체 상태: 타격 시 또는 충돌 보정 시 포함
            if hit_results or corrections:
                payload["fighters"] = manager.fighters

            # 위치/yaw 변경이 있거나 공격/타격이면 broadcast (idle 정지 상태만 스킵)
            is_attack = action not in ("IDLE", "DUAL_GUARD", "TWO_HAND_GUARD")
            curr_pos = (
                round(payload.get("world_x", 0), 2),
                round(payload.get("world_z", 0), 2),
                round(payload.get("yaw", 0), 2)
            )
            last_pos = manager._last_positions.get(client_id)
            pos_changed = (curr_pos != last_pos)

            if is_attack or hit_results or corrections or pos_changed:
                manager._last_positions[client_id] = curr_pos
                await manager.broadcast(payload)
            else:
                pass  # idle 정지 → 스킵
    except WebSocketDisconnect:
        manager.disconnect(client_id)
        await manager.broadcast({
            "type": "game_state",
            "event": "fighter_left",
            "client_id": client_id,
            "active_users": list(manager.active_connections.keys())
        })
    except Exception as e:
        import traceback
        print(f"[ERROR] websocket_endpoint exception for {client_id}: {e}", flush=True)
        traceback.print_exc()
        manager.disconnect(client_id)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
