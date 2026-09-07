# frozen_string_literal: true

module Mergify
  module RSpec
    # The Rust extension over mergify-ci-core: CI detection shared with the
    # pytest and TypeScript clients.
    #
    # Loading is best-effort by design. A precompiled gem carries one extension
    # per Ruby under `<ruby>/`, the source gem compiles one alongside this file,
    # and a platform we publish neither for gets neither. Detection is one input
    # to telemetry, not the point of the gem, so an absent extension degrades
    # what we can report rather than breaking the suite under test -- the same
    # fail-open posture the napi binding takes when a platform has no prebuilt
    # binary. `load_error` keeps the reason, for callers that want to say so.
    module Native
      class << self
        # The LoadError that prevented the extension loading, or nil.
        attr_accessor :load_error

        def available?
          load_error.nil?
        end
      end
    end
  end
end

begin
  # Precompiled gems ship lib/mergify/rspec/<ruby>/mergify_ci.<dlext>.
  require_relative "#{RUBY_VERSION.to_f}/mergify_ci"
rescue LoadError
  begin
    # Source gem, and any local `rake compile`.
    require_relative 'mergify_ci'
  rescue LoadError => e
    Mergify::RSpec::Native.load_error = e
  end
end
