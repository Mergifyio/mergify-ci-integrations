# frozen_string_literal: true

require 'opentelemetry-sdk'
require 'rspec/core/version'

module Mergify
  module RSpec
    module Resources
      # Detects OpenTelemetry Resource attributes for RSpec.
      module RSpec
        module_function

        def detect
          OpenTelemetry::SDK::Resources::Resource.create(
            'test.framework' => 'rspec',
            'test.framework.version' => ::RSpec::Core::Version::STRING
          )
        end
      end
    end
  end
end
