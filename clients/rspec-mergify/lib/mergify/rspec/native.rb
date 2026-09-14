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
      # Raised when a Mergify API call fails outright.
      #
      # Distinct from StandardError on purpose: callers degrade on an API
      # failure, and a bare rescue there would swallow genuine bugs in the
      # binding as though the backend were down.
      class ApiError < StandardError; end

      class << self
        # The LoadError that prevented the extension loading, or nil.
        attr_accessor :load_error

        def available?
          load_error.nil?
        end

        # Which of the two failed requires actually explains the absence.
        #
        # A precompiled gem ships lib/mergify/rspec/<ruby>/mergify_ci.<dlext>,
        # so when one is packed for this Ruby that require is the real attempt:
        # it fails with something like "version `GLIBC_2.29' not found", and the
        # fallback that follows only ever adds "cannot load such file", which
        # sends the reader looking for the wrong thing. With no extension for
        # this Ruby -- the source gem, or a platform we publish no gem for --
        # it is the other way round.
        # Require a file next to this one, returning the LoadError instead of
        # raising it. Two attempts read better as values than as nested rescues.
        def attempt_require(path)
          require_relative path
          nil
        rescue LoadError => e
          e
        end

        def load_failure_reason(versioned, fallback)
          packed = Dir.glob(File.join(__dir__, RUBY_VERSION.to_f.to_s, 'mergify_ci.*')).any?
          packed ? versioned : fallback
        end
      end
    end
  end
end

# Precompiled gems ship lib/mergify/rspec/<ruby>/mergify_ci.<dlext>; the source
# gem and any local `rake compile` put one beside this file instead.
versioned_error = Mergify::RSpec::Native.attempt_require("#{RUBY_VERSION.to_f}/mergify_ci")
fallback_error = versioned_error && Mergify::RSpec::Native.attempt_require('mergify_ci')

if fallback_error
  Mergify::RSpec::Native.load_error =
    Mergify::RSpec::Native.load_failure_reason(versioned_error, fallback_error)
end

unless Mergify::RSpec::Native.available?
  # Stand in for the extension so callers can just ask, and get the same answer
  # they would get from a machine that is not in CI. Branching on availability
  # at every call site would only spread the same nil back through the caller.
  module Mergify
    module RSpec
      module Native
        class << self
          def detect_provider
            nil
          end

          def detect_repository_name
            nil
          end

          def detect_attributes
            {}
          end
        end
      end
    end
  end
end
