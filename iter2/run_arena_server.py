import os
import sys
import argparse
import uvicorn

server_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "server")
sys.path.insert(0, server_dir)

from app import app
from ssl_helper import generate_self_signed_cert

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8000, help="서버 포트")
    parser.add_argument("--no-ssl", action="store_true", help="HTTP 모드로 실행")
    args = parser.parse_args()

    use_ssl = not args.no_ssl
    protocol = "https" if use_ssl else "http"

    cert_path, key_path = None, None
    if use_ssl:
        cert_path, key_path = generate_self_signed_cert(server_dir)

    print("=" * 70)
    print(f"🥊 [HOST] 4-Player AR Shadow Boxing & Battle Arena ({protocol.upper()} 모드)")
    print("=" * 70)
    print(f"[1] Host 대형 스크린 3D 링 주소: {protocol}://localhost:{args.port}/arena")
    print(f"[2] 4인 파이터 웹캠 접속 주소 (다른 랩탑 브라우저 접속):")
    print(f"    - Fighter 1 (Red)   : {protocol}://147.47.201.63:{args.port}/client?id=client_1")
    print(f"    - Fighter 2 (Cyan)  : {protocol}://147.47.201.63:{args.port}/client?id=client_2")
    print(f"    - Fighter 3 (Gold)  : {protocol}://147.47.201.63:{args.port}/client?id=client_3")
    print(f"    - Fighter 4 (Green) : {protocol}://147.47.201.63:{args.port}/client?id=client_4")
    print("=" * 70)

    if use_ssl:
        uvicorn.run(app, host="0.0.0.0", port=args.port, ssl_certfile=cert_path, ssl_keyfile=key_path, timeout_graceful_shutdown=0)
    else:
        uvicorn.run(app, host="0.0.0.0", port=args.port, timeout_graceful_shutdown=0)

