# frozen_string_literal: true

require 'opentelemetry-sdk'
require_relative '../utils'

module Mergify
  module RSpec
    module Resources
      # Detects OpenTelemetry Resource attributes for Mergify-specific fields.
      module Mergify
        module_function

        MERGIFY_MAPPING = {
          'mergify.test.job.name' => [:to_s, 'MERGIFY_TEST_JOB_NAME']
        }.freeze

        def detect
          attributes = Utils.get_attributes(MERGIFY_MAPPING)
          OpenTelemetry::SDK::Resources::Resource.create(attributes)
        end
      end
    end
  end
end
