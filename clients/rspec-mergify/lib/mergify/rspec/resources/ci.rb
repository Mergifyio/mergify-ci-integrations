# frozen_string_literal: true

require 'opentelemetry-sdk'
require_relative '../utils'

module Mergify
  module RSpec
    module Resources
      # Detects OpenTelemetry Resource attributes for the CI provider.
      module CI
        module_function

        def detect
          provider = Utils.ci_provider
          return OpenTelemetry::SDK::Resources::Resource.create({}) if provider.nil?

          OpenTelemetry::SDK::Resources::Resource.create(
            'cicd.provider.name' => provider.to_s
          )
        end
      end
    end
  end
end
