# frozen_string_literal: true

require 'rspec_mergify'
require 'webmock/rspec'
require 'timecop'
require_relative 'support/stub_api_server'

# A safety net for Ruby-side HTTP only. The gem's own requests leave from Rust
# now, which WebMock cannot see, let alone block -- specs that exercise them
# stub the binding's client instead, or point it at a loopback server.
WebMock.disable_net_connect!

RSpec.configure do |config|
  config.expect_with :rspec do |expectations|
    expectations.include_chain_clauses_in_custom_matcher_descriptions = true
  end

  config.mock_with :rspec do |mocks|
    mocks.verify_partial_doubles = true
  end

  config.include StubApiServer

  config.filter_run_when_matching :focus
  config.order = :random
end
