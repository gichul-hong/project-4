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
    parser.add_argument("--no-ssl", action="store_true", help="HTTP 모드로 실행 (기본값은 웹캠 지원을 위한 HTTPS 모드)")
    parser.add_argument("--port", type=int, default=8000, help="포트 번호")
    args = parser.parse_args()

    use_ssl = not args.no_ssl
    protocol = "https" if use_ssl else "http"
    
    cert_path, key_path = None, None
    if use_ssl:
        cert_path, key_path = generate_self_signed_cert(server_dir)

    print("=" * 70)
    print(f"🏺 [HOST] 고대 이집트 피라미드 AR 메인 서버 실행 ({protocol.upper()} 모드)")
    print("=" * 70)
    print(f"[1] Host 3D 뷰어 주소 (대형 스크린): {protocol}://localhost:{args.port}")
    print(f"[2] 다른 랩탑 웹캠 클라이언트 접속 주소 (브라우저 접속):")
    print(f"    - User 1 (Red)   : {protocol}://147.47.201.63:{args.port}/client?id=client_1")
    print(f"    - User 2 (Cyan)  : {protocol}://147.47.201.63:{args.port}/client?id=client_2")
    print(f"    - User 3 (Gold)  : {protocol}://147.47.201.63:{args.port}/client?id=client_3")
    print(f"    - User 4 (Green) : {protocol}://147.47.201.63:{args.port}/client?id=client_4")
    if use_ssl:
        print("\n💡 [HTTPS 안내] 브라우저 첫 접속 시 '고급' -> '안전하지 않음으로 이동'을 클릭하세요.")
        print("   (자체 서명 인증서로 인해 표시되는 정상적인 브라우저 보안 알림입니다)")
    print("=" * 70)

    if use_ssl:
        uvicorn.run(app, host="0.0.0.0", port=args.port, ssl_certfile=cert_path, ssl_keyfile=key_path)
    else:
        uvicorn.run(app, host="0.0.0.0", port=args.port)
