import hashlib
import http.server
import importlib.util
import shutil
import socket
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "plugins/roku-device-toolkit/skills/roku-device-operator/scripts/roku_device.py"
SPEC = importlib.util.spec_from_file_location("roku_device_integration", PATH)
device = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(device)


class QuietHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass


class DeviceIntegrationTests(unittest.TestCase):
    def serve(self, handler):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)
        return server

    def test_ecp_http_query_keypress_encoding_and_error(self):
        requests = []

        class Handler(QuietHandler):
            def handle_request(self):
                requests.append((self.command, self.path))
                if self.path == "/query/device-info":
                    payload = b"<device-info><model-name>Test</model-name></device-info>"
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                elif self.path == "/query/apps":
                    self.send_error(503)
                else:
                    self.send_response(200)
                    self.send_header("Content-Length", "0")
                    self.end_headers()

            do_GET = handle_request
            do_POST = handle_request

        server = self.serve(Handler)
        with mock.patch.object(device, "ECP_PORT", server.server_port):
            payload = device.request("127.0.0.1", "GET", "/query/device-info", 2)
            device.keypress("127.0.0.1", "Lit_a b/?", 2)
            with self.assertRaisesRegex(SystemExit, "HTTP 503 for /query/apps"):
                device.request("127.0.0.1", "GET", "/query/apps", 2)

        self.assertIn(b"<model-name>Test</model-name>", payload)
        self.assertEqual(
            requests,
            [
                ("GET", "/query/device-info"),
                ("POST", "/keypress/Lit_a%20b%2F%3F"),
                ("GET", "/query/apps"),
            ],
        )

    @unittest.skipUnless(shutil.which("curl"), "curl is required for digest integration")
    def test_digest_authentication_uses_challenge_response(self):
        authorization = []
        synthetic_password = 'integration-only-\\"password'

        def valid_digest(header):
            if not header or not header.startswith("Digest "):
                return False
            fields = urllib.request.parse_keqv_list(
                urllib.request.parse_http_list(header.removeprefix("Digest "))
            )
            required = {
                "username", "realm", "nonce", "uri", "response", "qop", "nc", "cnonce"
            }
            if not required.issubset(fields):
                return False
            if fields["username"] != "rokudev" or fields["realm"] != "rokudev":
                return False
            if (
                fields["nonce"] != "test-nonce"
                or fields["qop"] != "auth"
                or fields["uri"] != "/plugin_inspect"
            ):
                return False
            ha1 = hashlib.md5(
                f'rokudev:rokudev:{synthetic_password}'.encode()
            ).hexdigest()
            ha2 = hashlib.md5(f'GET:{fields["uri"]}'.encode()).hexdigest()
            expected = hashlib.md5(
                f'{ha1}:test-nonce:{fields["nc"]}:{fields["cnonce"]}:auth:{ha2}'.encode()
            ).hexdigest()
            return fields["response"] == expected

        class Handler(QuietHandler):
            def do_GET(self):
                header = self.headers.get("Authorization")
                authorization.append(header)
                if not valid_digest(header):
                    self.send_response(401)
                    self.send_header(
                        "WWW-Authenticate",
                        'Digest realm="rokudev", nonce="test-nonce", qop="auth", algorithm=MD5',
                    )
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                payload = b"digest-ok"
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = self.serve(Handler)
        with mock.patch.object(
            device,
            "trusted_developer_host",
            return_value=f"127.0.0.1:{server.server_port}",
        ), mock.patch.object(device, "require_password", return_value=synthetic_password):
            response = device.curl_digest("test.invalid", "/plugin_inspect", [])

        self.assertEqual(response, "digest-ok")
        self.assertEqual(authorization[0], None)
        self.assertTrue(authorization[1].startswith("Digest "))
        self.assertNotIn(synthetic_password, authorization[1])

    def test_console_capture_reads_real_socket_stream(self):
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        self.addCleanup(listener.close)

        def send_logs():
            connection, _address = listener.accept()
            with connection:
                connection.sendall(b"BrightScript integration log\n")
                time.sleep(0.25)

        thread = threading.Thread(target=send_logs, daemon=True)
        thread.start()
        with tempfile.TemporaryDirectory() as temporary, mock.patch.object(
            device, "CONSOLE_PORT", listener.getsockname()[1]
        ):
            output = Path(temporary) / "console.log"
            device.collect_logs("127.0.0.1", 0.1, output)
            self.assertEqual(output.read_bytes(), b"BrightScript integration log\n")
        thread.join(2)
        self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
