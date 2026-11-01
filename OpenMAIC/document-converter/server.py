"""Internal, bounded HTTP adapter. Public uploads go through Next.js identity checks."""
from __future__ import annotations

import hmac
import importlib.metadata
import json
import multiprocessing as mp
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from converter import ADAPTER_VERSION, FILE_LIMIT, ConversionError, convert_document

TIMEOUT = min(65, max(5, int(os.getenv("DOCUMENT_CONVERTER_TIMEOUT", "60"))))
ADMISSION = threading.BoundedSemaphore(2)


def _worker(connection, payload: bytes, format: str):
    try:
        connection.send((200, convert_document(payload, format)))
    except ConversionError as error:
        connection.send((error.status, {"code": error.code, "message": error.message}))
    except Exception:
        connection.send((500, {"code": "DOCUMENT_CONVERSION_FAILED", "message": "文档转换服务未能完成处理，请稍后重试。"}))
    finally:
        connection.close()


class Handler(BaseHTTPRequestHandler):
    server_version = "DocumentConverter/1"

    def log_message(self, format, *args):
        # Do not log uploaded bytes, names, document text or auth headers.
        return

    def _send(self, status: int, body: dict):
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path != "/health":
            self._send(404, {"code": "NOT_FOUND", "message": "接口不存在。"})
            return
        self._send(200, {"status": "ok", "adapterVersion": ADAPTER_VERSION,
                         "version": importlib.metadata.version("markitdown"),
                         "formats": ["docx", "pdf"], "formulaHandling": "deferred"})

    def do_POST(self):
        if self.path not in {"/convert/docx", "/convert/pdf"}:
            self._send(404, {"code": "NOT_FOUND", "message": "接口不存在。"})
            return
        token = os.getenv("DOCUMENT_CONVERTER_TOKEN", "").strip()
        if token and not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
            self._send(401, {"code": "UNAUTHORIZED", "message": "服务认证失败。"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > FILE_LIMIT:
            self._send(413, {"code": "MATERIAL_LIMIT_EXCEEDED", "message": "请选择不超过8 MiB的非空文档。"})
            return
        if not ADMISSION.acquire(blocking=False):
            self._send(429, {"code": "DOCUMENT_BUSY", "message": "文档转换繁忙，请稍后重试。"})
            return
        process = None
        receiver = sender = None
        try:
            self.connection.settimeout(30)
            payload = self.rfile.read(length)
            if len(payload) != length:
                self._send(400, {"code": "MATERIAL_INVALID", "message": "上传未完成，请重新选择文件。"})
                return
            context = mp.get_context("spawn")
            receiver, sender = context.Pipe(duplex=False)
            process = context.Process(target=_worker, args=(sender, payload, self.path.rsplit("/", 1)[1]), daemon=True)
            process.start()
            sender.close()
            if not receiver.poll(TIMEOUT):
                self._send(504, {"code": "DOCUMENT_TIMEOUT", "message": "文档转换超时，请拆分文件后重试。"})
                return
            status, result = receiver.recv()
            self._send(status, result)
        except (EOFError, OSError, socket.timeout):
            self._send(503, {"code": "DOCUMENT_CONVERSION_FAILED", "message": "文档转换未完成，请重试。"})
        finally:
            if process is not None:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=3)
            if receiver is not None:
                receiver.close()
            if sender is not None:
                sender.close()
            ADMISSION.release()


if __name__ == "__main__":
    mp.freeze_support()
    host = os.getenv("DOCUMENT_CONVERTER_HOST", "127.0.0.1")
    port = int(os.getenv("DOCUMENT_CONVERTER_PORT", "9040"))
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    print(f"Document converter ready on {host}:{port}; Word formulas deferred", flush=True)
    server.serve_forever()
