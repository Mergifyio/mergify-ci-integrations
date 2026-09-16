# frozen_string_literal: true

require 'rspec/core/version'

module Mergify
  module RSpec
    module Resources
      # The resource attributes only Ruby knows: which framework ran the suite,
      # and in which language.
      module RSpec
        module_function

        def detect
          {
            'test.framework' => 'rspec',
            'test.framework.version' => ::RSpec::Core::Version::STRING,
            # Mergify takes a test's language from here when the span does not
            # name one. The OpenTelemetry SDK sets this on its default resource,
            # but this gem never used that resource, so nothing had ever sent it.
            'telemetry.sdk.language' => 'ruby'
          }
        end
      end
    end
  end
end
