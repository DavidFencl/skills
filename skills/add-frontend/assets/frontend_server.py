import os
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# The frontend derives the app's WebSocket address (port 8765) from this port.
PORT = 8082
DIST = (Path(__file__).resolve().parent / "frontend/dist").resolve()


class _FrontendHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        if self._is_browser_route():
            self.path = "/index.html"
        return super().send_head()

    def _is_browser_route(self):
        target = self.translate_path(self.path)
        return not os.path.isfile(target) and not os.path.splitext(target)[1]

    def log_message(self, format, *args):
        pass


def serve_frontend(host="0.0.0.0", port=PORT, dist=None):
    """Starts serving the built frontend in a background thread and returns the server.

    Returns None in standalone mode, where the oakapp serves the frontend.
    """
    if os.environ.get("OAKAPP_STATIC_FRONTEND_PORT"):
        return None
    directory = Path(dist or os.environ.get("OAKAPP_STATIC_FRONTEND_PATH") or DIST)
    if not (directory / "index.html").is_file():
        raise FileNotFoundError(
            f"{directory / 'index.html'} does not exist. Build the frontend first: "
            "cd frontend && npm ci && npm run build"
        )
    server = ThreadingHTTPServer((host, port), partial(_FrontendHandler, directory=str(directory)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    print(f"Frontend: http://localhost:{port}")
    return server
