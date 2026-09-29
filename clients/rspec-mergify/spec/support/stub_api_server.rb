# frozen_string_literal: true

require 'socket'
require 'zlib'

# A real HTTP server for the specs that exercise the Rust API client.
#
# WebMock cannot reach it: it intercepts Ruby's Net::HTTP, while the binding
# issues its requests from Rust, which goes straight to the socket. So the
# client gets a real server on a loopback port instead of a stubbed one --
# the same choice pytest-mergify made for its trace-upload tests.
module StubApiServer
  # Serves one canned response to every request, then yields the base URL,
  # the paths it was asked for, and the request bodies (gunzipped), so a caller
  # can assert on them. `routes` answers the requests whose path contains a
  # key with that key's `[status, body]` instead, for a run that asks several
  # endpoints for different things.
  def with_stub_api(status:, body:, routes: {})
    server = TCPServer.new('127.0.0.1', 0)
    paths = []
    bodies = []
    mutex = Mutex.new
    thread = Thread.new do
      loop do
        socket = server.accept
        request_line = socket.gets
        request_body = read_request_body(socket)
        path = request_line.to_s.split[1]
        mutex.synchronize do
          paths << path
          bodies << request_body
        end
        route = routes.find { |fragment, _| path.to_s.include?(fragment) }
        answer_status, answer_body = route ? route.last : [status, body]
        socket.print(
          "HTTP/1.1 #{answer_status} #{answer_status == 200 ? 'OK' : 'Error'}\r\n" \
          "Content-Type: application/json\r\n" \
          "Content-Length: #{answer_body.bytesize}\r\n" \
          "Connection: close\r\n\r\n#{answer_body}"
        )
        socket.close
      rescue StandardError
        nil
      end
    end

    yield "http://127.0.0.1:#{server.addr[1]}", paths, bodies
  ensure
    thread&.kill
    server&.close
  end

  private

  def read_request_body(socket)
    headers = {}
    while (line = socket.gets) && line != "\r\n"
      name, value = line.split(':', 2)
      headers[name.strip.downcase] = value.to_s.strip
    end
    raw = socket.read(headers.fetch('content-length', '0').to_i).to_s
    headers['content-encoding'] == 'gzip' ? Zlib.gunzip(raw) : raw
  end
end
