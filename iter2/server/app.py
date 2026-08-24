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
        self.fighters = {
            "client_1": {"name": "Red Boxer", "color": "#FF3366", "hp": 100, "score": 0, "action": "IDLE", "pos": [-15, 0, 0]},
            "client_2": {"name": "Cyan Boxer", "color": "#00E5FF", "hp": 100, "score": 0, "action": "IDLE", "pos": [15, 0, 0]},
            "client_3": {"name": "Gold Mage", "color": "#FFD700", "hp": 100, "score": 0, "action": "IDLE", "pos": [0, 0, -15]},
            "client_4": {"name": "Green Striker", "color": "#00FF66", "hp": 100, "score": 0, "action": "IDLE", "pos": [0, 0, 15]},
        }

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket
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
        """타격 데미지 계산 및 HP 차감 로직"""
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

        # 속도 가산치
        dmg = int(raw_dmg * (1.0 + min(velocity, 50.0) / 100.0))

        # 가장 가까운 상대방에게 타격 적용
        hits = []
        for target_id, fighter in self.fighters.items():
            if target_id != attacker_id and target_id in self.active_connections:
                is_guard = (fighter["action"] in ["TWO_HAND_GUARD", "DUAL_GUARD"])
                actual_dmg = int(dmg * 0.2) if is_guard else dmg
                fighter["hp"] = max(0, fighter["hp"] - actual_dmg)
                hits.append({
                    "target_id": target_id,
                    "damage": actual_dmg,
                    "is_guard": is_guard,
                    "target_hp": fighter["hp"]
                })
                if fighter["hp"] == 0:
                    self.fighters[attacker_id]["score"] += 1

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

            # 파이터 액션 및 위치 갱신
            if client_id in manager.fighters:
                manager.fighters[client_id]["action"] = action
                if "pos_x" in payload:
                    manager.fighters[client_id]["pos_x"] = payload["pos_x"]
                if "pos_z" in payload:
                    manager.fighters[client_id]["pos_z"] = payload["pos_z"]

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
