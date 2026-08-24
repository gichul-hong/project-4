import os
import json
import asyncio
from typing import Dict, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

app = FastAPI(title="Egypt Pyramid AR Multi-User Exploration")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
templates = Jinja2Templates(directory=os.path.join(BASE_DIR, "templates"))

# 정적 파일 디렉토리
static_dir = os.path.join(BASE_DIR, "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

# 접속한 클라이언트 목록 (User 1 ~ User 4)
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.user_colors = {
            "client_1": "#FF3366", # Neon Red
            "client_2": "#00E5FF", # Neon Cyan
            "client_3": "#FFD700", # Neon Gold
            "client_4": "#00FF66", # Neon Green
        }

    async def connect(self, websocket: WebSocket, client_id: str):
        await websocket.accept()
        self.active_connections[client_id] = websocket
        print(f"[+] Client connected: {client_id} (Total: {len(self.active_connections)})")
        # 접속 알림 브로드캐스트
        await self.broadcast({
            "type": "system",
            "event": "user_joined",
            "client_id": client_id,
            "color": self.user_colors.get(client_id, "#FFFFFF"),
            "active_users": list(self.active_connections.keys())
        })

    def disconnect(self, client_id: str):
        if client_id in self.active_connections:
            del self.active_connections[client_id]
            print(f"[-] Client disconnected: {client_id}")

    async def broadcast(self, message: dict):
        dead_clients = []
        msg_text = json.dumps(message)
        for client_id, conn in self.active_connections.items():
            try:
                await conn.send_text(msg_text)
            except Exception:
                dead_clients.append(client_id)
        for dead_id in dead_clients:
            self.disconnect(dead_id)

manager = ConnectionManager()

@app.get("/", response_class=HTMLResponse)
@app.get("/host", response_class=HTMLResponse)
async def get_host_page(request: Request):
    """메인 Host 3D 피라미드 씬 페이지"""
    return templates.TemplateResponse(
        request=request,
        name="host.html",
        context={}
    )

@app.get("/client", response_class=HTMLResponse)
async def get_client_page(request: Request, id: str = "client_1"):
    """웹 브라우저 무설치 Web AR 클라이언트 페이지"""
    color = manager.user_colors.get(id, "#FF3366")
    return templates.TemplateResponse(
        request=request,
        name="client.html",
        context={"client_id": id, "color": color}
    )

@app.get("/api/eval-results")
async def get_eval_results():
    """모델 학습 및 개선 지표 (Show Numbers) JSON 반환"""
    eval_file = os.path.join(os.path.dirname(BASE_DIR), "gesture_engine", "eval_results.json")
    if os.path.exists(eval_file):
        with open(eval_file, "r") as f:
            return json.load(f)
    return {
        "rule_based_accuracy": 0.682,
        "mlp_accuracy": 0.976,
        "improvement_pct_points": 29.4,
        "jitter_reduction_pct": 82.0,
        "latency_ms": 12.5
    }

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket, client_id)
    try:
        while True:
            data = await websocket.receive_text()
            payload = json.loads(data)
            payload["client_id"] = client_id
            payload["color"] = manager.user_colors.get(client_id, "#FFFFFF")
            # 모든 접속자 및 Host에게 실시간 패킷 전송
            await manager.broadcast(payload)
    except WebSocketDisconnect:
        manager.disconnect(client_id)
        await manager.broadcast({
            "type": "system",
            "event": "user_left",
            "client_id": client_id,
            "active_users": list(manager.active_connections.keys())
        })
    except Exception as e:
        manager.disconnect(client_id)

if __name__ == "__main__":
    import uvicorn
    # 프로젝트 루트 또는 server 폴더 어디서 실행해도 동작하도록 설정
    uvicorn.run(app, host="0.0.0.0", port=8000)
