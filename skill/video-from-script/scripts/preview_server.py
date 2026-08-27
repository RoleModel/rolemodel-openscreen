"""Static file server that supports HTTP Range requests.

`python3 -m http.server` ignores Range headers, so a browser cannot seek within
a video it serves: `seekable` stays empty and assigning `currentTime` is silently
dropped. The review page is built entirely on seeking into the uncut sources, so
it needs a server that answers 206 Partial Content.

    python3 preview_server.py --directory "$(git rev-parse --show-toplevel)" --port 8000
"""

import argparse
import os
import re
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


RANGE_PATTERN = re.compile(r"bytes=(\d*)-(\d*)")


class _LimitedReader:
    def __init__(self, handle, remaining):
        self.handle = handle
        self.remaining = remaining

    def read(self, size=-1):
        if self.remaining <= 0:
            return b""
        if size is None or size < 0:
            size = self.remaining
        chunk = self.handle.read(min(size, self.remaining))
        self.remaining -= len(chunk)
        return chunk

    def close(self):
        self.handle.close()


class RangeRequestHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        header = self.headers.get("Range")
        if not header:
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            return super().send_head()

        match = RANGE_PATTERN.fullmatch(header.strip())
        if not match:
            return super().send_head()

        try:
            handle = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        size = os.fstat(handle.fileno()).st_size
        start_text, end_text = match.groups()

        if start_text:
            start = int(start_text)
            end = int(end_text) if end_text else size - 1
        elif end_text:
            start = max(0, size - int(end_text))
            end = size - 1
        else:
            handle.close()
            return super().send_head()

        if start >= size:
            handle.close()
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None

        end = min(end, size - 1)
        handle.seek(start)

        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()

        return _LimitedReader(handle, end - start + 1)

    def log_message(self, *args):
        pass


def main(argv=None):
    parser = argparse.ArgumentParser(description="Serve a directory with Range support")
    parser.add_argument("--directory", default=os.getcwd(), help="directory to serve")
    parser.add_argument("--port", type=int, default=8000, help="port to bind")
    arguments = parser.parse_args(argv)

    handler = partial(RangeRequestHandler, directory=arguments.directory)
    ThreadingHTTPServer.allow_reuse_address = True

    with ThreadingHTTPServer(("127.0.0.1", arguments.port), handler) as server:
        print(f"serving {arguments.directory} on http://localhost:{arguments.port}")
        sys.stdout.flush()
        server.serve_forever()

    return 0


if __name__ == "__main__":
    sys.exit(main())
