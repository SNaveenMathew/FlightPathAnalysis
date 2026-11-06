"""Launcher script for the Flight Phase Visualization and Manual Tagging App.

Usage:
    python run_app.py [--host 127.0.0.1] [--port 8000] [--no-browser]
"""

import argparse
import socket
import sys
import webbrowser
from pathlib import Path

# Add project root to sys.path
PROJECT_ROOT = Path(__file__).resolve().parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))


def find_free_port(start_port: int = 8000, max_attempts: int = 20) -> int:
    """Find a free port starting from start_port."""
    for port in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            res = sock.connect_ex(("127.0.0.1", port))
            if res != 0:
                return port
    return start_port


def main():
    parser = argparse.ArgumentParser(description="Run the Flight Phase Explorer & Manual Tagging App")
    parser.add_argument("--host", default="127.0.0.1", help="Host address (default: 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000, help="Port (default: 8000)")
    parser.add_argument("--no-browser", action="store_true", help="Do not automatically open web browser")
    args = parser.parse_args()

    port = find_free_port(args.port)
    url = f"http://{args.host}:{port}"

    print("=" * 70)
    print("   ✈️  FLIGHT PHASE EXPLORER & MANUAL TAGGING STUDIO")
    print("=" * 70)
    print(f"Server starting at: {url}")
    print("• Hierarchical Selection: Aircraft -> Sessions (defaults to all)")
    print("• Synchronized 2D Radar Map & Altitude Profile animation")
    print("• Interactive Manual Flight Phase Tagging Studio")
    print("• Heuristic Refinement & Evaluation against flight_phase.py")
    print("=" * 70)

    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass

    import uvicorn
    uvicorn.run("flight_phase_app.server:app", host=args.host, port=port, log_level="info")


if __name__ == "__main__":
    main()

