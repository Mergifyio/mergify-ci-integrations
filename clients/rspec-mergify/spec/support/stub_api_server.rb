# frozen_string_literal: true

require 'socket'

# A real HTTP server for the specs that exercise the Rust API client.
#
# WebMock cannot reach it: it intercepts Ruby's Net::HTTP, while the binding
# issues its requests from Rust, which goes straight to the socket. So the
# client gets a real server on a loopback port instead of a stubbed one --
# the same choice pytest-mergify made for its trace-upload tests.
module StubApiServer
  # Serves one canned response to every request, then yields the base URL.
  # Also yields the paths it was asked for and each request's User-Agent, so a
  # caller can assert on them.
  def with_stub_api(status:, body:)
    server = TCPServer.new('127.0.0.1', 0)
    paths = []
    user_agents = []
    mutex = Mutex.new
    thread = Thread.new do
      loop do
        socket = server.accept
        request_line = socket.gets
        user_agent = read_user_agent(socket)
        mutex.synchronize do
          paths << request_line.to_s.split[1]
          user_agents << user_agent
        end
        socket.print(
          "HTTP/1.1 #{status} #{status == 200 ? 'OK' : 'Error'}\r\n" \
          "Content-Type: application/json\r\n" \
          "Content-Length: #{body.bytesize}\r\n" \
          "Connection: close\r\n\r\n#{body}"
        )
        socket.close
      rescue StandardError
        nil
      end
    end

    yield "http://127.0.0.1:#{server.addr[1]}", paths, user_agents
  ensure
    thread&.kill
    server&.close
  end

  # Drains a request's headers, returning its User-Agent (nil when it sent none).
  def read_user_agent(socket)
    user_agent = nil
    while (line = socket.gets) && line != "\r\n"
      name, value = line.split(':', 2)
      user_agent = value.strip if name.casecmp?('user-agent')
    end
    user_agent
  end
end
