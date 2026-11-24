import http.server, socketserver, json, os

BASE = os.path.dirname(os.path.abspath(__file__))
PORT = 8799
with open(os.path.join(BASE, 'mock_data.json'), encoding='utf-8') as f:
    DATA = f.read().encode('utf-8')

class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=BASE, **kw)
    def do_GET(self):
        if self.path == '/api/stats':
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(DATA)))
            self.end_headers()
            self.wfile.write(DATA)
            return
        super().do_GET()
    def log_message(self, *a):
        pass

with socketserver.TCPServer(('127.0.0.1', PORT), H) as httpd:
    print(f'mock server on :{PORT}')
    httpd.serve_forever()