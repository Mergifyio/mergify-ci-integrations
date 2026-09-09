# frozen_string_literal: true

require 'rspec/core/version'

module Mergify
  module RSpec
    module Resources
      # The resource attributes only Ruby knows: which framework ran the suite.
      module RSpec
        module_function

        def detect
          {
            'test.framework' => 'rspec',
            'test.framework.version' => ::RSpec::Core::Version::STRING
          }
        end
      end
    end
  end
end
