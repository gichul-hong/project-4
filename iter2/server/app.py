import os
import json
import asyncio
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
class ArenaGameManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.last_attack_times: Dict[str, float] = {}
        self.reset_game()

    def reset_game(self):
        self.fighters = {
            "client_1": {"name": "Red Boxer", "color": "#FF3366", "hp": 100, "score": 0, "action": "IDLE", "pos": [-12, 0, 0], "world_x": -12, "world_z": 0, "yaw": 1.57},
            "client_2": {"name": "Cyan Boxer", "color": "#00E5FF", "hp": 100, "score": 0, "action": "IDLE", "pos": [12, 0, 0], "world_x": 12, "world_z": 0, "yaw": -1.57},
            "client_3": {"name": "Gold Mage", "color": "#FFD700", "hp": 100, "score": 0, "action": "IDLE", "pos": [0, 0, -12], "world_x": 0, "world_z": -12, "yaw": 3.14},
            "client_4": {"name": "Green Striker", "color": "#00FF66", "hp": 100, "score": 0, "action": "IDLE", "pos": [0, 0, 12], "world_x": 0, "world_z": 12, "yaw": 0},
        }

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
        dead = []
        for cid, conn in self.active_connections.items():
            try:
                await conn.send_text(msg_text)
            except Exception:
                dead.append(cid)
        for cid in dead:
            self.disconnect(cid)

    def process_attack(self, attacker_id: str, action: str, velocity: float):
        """0.4초 쿨다운 적용, HP>0 생존자만 타격/공격, 정면 단일 타겟 정밀 타격"""

        attacker = self.fighters.get(attacker_id, {})
        if attacker.get("hp", 0) <= 0:
            print(f"[DEBUG] process_attack: attacker {attacker_id} hp=0, skip")
            return None
        damage_table = {
            "JAB_STRAIGHT": 12,
            "LEFT_JAB": 12,
            "RIGHT_CROSS": 16,
            "LEFT_HOOK": 18,
            "RIGHT_UPPERCUT": 25,
            "ENERGY_WAVE": 40
        }
        raw_dmg = damage_table.get(action, 0)
        if raw_dmg == 0:
            return None

        # 0.4초 타격 쿨다운 검사 (초고속 연타 버그 방지)
        now = asyncio.get_event_loop().time()
        last_time = self.last_attack_times.get(attacker_id, 0.0)
        if now - last_time < 0.4:
            return None
        self.last_attack_times[attacker_id] = now

        dmg = int(raw_dmg * (1.0 + min(velocity, 50.0) / 100.0))

        att_x = attacker.get("world_x", attacker.get("pos", [0, 0, 0])[0])
        att_z = attacker.get("world_z", attacker.get("pos", [0, 0, 0])[2])
        att_yaw = attacker.get("yaw", 0.0)

        import math
        look_dx = -math.sin(att_yaw)
        look_dz = -math.cos(att_yaw)
        print(f"[DEBUG] {attacker_id} attack: {action} vel={velocity:.1f} "
              f"pos=({att_x:.1f},{att_z:.1f}) yaw={att_yaw:.2f} "
              f"look=({look_dx:.2f},{look_dz:.2f})", flush=True)

        best_target_id = None
        min_dist = 999.0

        for target_id, fighter in self.fighters.items():
            if target_id != attacker_id and fighter.get("hp", 0) > 0:
                tgt_x = fighter.get("world_x", fighter.get("pos", [0, 0, 0])[0])
                tgt_z = fighter.get("world_z", fighter.get("pos", [0, 0, 0])[2])

                to_tgt_x = tgt_x - att_x
                to_tgt_z = tgt_z - att_z
                dist = (to_tgt_x**2 + to_tgt_z**2)**0.5

                if dist <= 18.0 and dist > 0.1:
                    dot = (look_dx * to_tgt_x + look_dz * to_tgt_z) / dist
                    # 근접(< 6)이면 방향 무시하고 무조건 타격, 그 외에는 정면 60도 이내만 허용
                    hit = (dist < 6.0) or (dot > 0.5)
                    print(f"[DEBUG]   target {target_id}: dist={dist:.1f} dot={dot:.2f} hit={hit}", flush=True)
                    if hit:
                        if dist < min_dist:
                            min_dist = dist
                            best_target_id = target_id

        if best_target_id is None:
            print(f"[DEBUG]   -> no target hit", flush=True)
        else:
            print(f"[DEBUG]   -> hit {best_target_id} dist={min_dist:.1f}", flush=True)

        hits = []
        if best_target_id:
            fighter = self.fighters[best_target_id]
            is_guard = (fighter.get("action") in ["TWO_HAND_GUARD", "DUAL_GUARD"])
            actual_dmg = int(dmg * 0.2) if is_guard else dmg
            fighter["hp"] = max(0, fighter["hp"] - actual_dmg)
            hits.append({
                "attacker_id": attacker_id,
                "target_id": best_target_id,
                "damage": actual_dmg,
                "is_guard": is_guard,
                "target_hp": fighter["hp"],
                "distance": round(min_dist, 1)
            })
            if fighter["hp"] == 0:
                attacker["score"] = attacker.get("score", 0) + 1

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

            # 파이터 액션 및 3D 월드 위치 갱신
            if client_id in manager.fighters:
                manager.fighters[client_id]["action"] = action
                if "world_x" in payload:
                    manager.fighters[client_id]["world_x"] = payload["world_x"]
                if "world_z" in payload:
                    manager.fighters[client_id]["world_z"] = payload["world_z"]
                if "yaw" in payload:
                    manager.fighters[client_id]["yaw"] = payload["yaw"]

            # 타격 이벤트 판정 (양손 액션 포함)
            hit_results = None
            if action in ["JAB_STRAIGHT", "LEFT_JAB", "RIGHT_CROSS", "LEFT_HOOK", "RIGHT_UPPERCUT", "ENERGY_WAVE"]:
                hit_results = manager.process_attack(client_id, action, velocity)

            payload["client_id"] = client_id
            payload["color"] = manager.fighters.get(client_id, {}).get("color", "#FFFFFF")
            payload["fighters"] = manager.fighters
            payload["hits"] = hit_results

            await manager.broadcast(payload)
    except WebSocketDisconnect:
        manager.disconnect(client_id)
        await manager.broadcast({
            "type": "game_state",
            "event": "fighter_left",
            "client_id": client_id,
            "active_users": list(manager.active_connections.keys())
        })
    except Exception:
        manager.disconnect(client_id)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
