# frozen_string_literal: true

require 'opentelemetry-sdk'
require_relative '../utils'

module Mergify
  module RSpec
    module Resources
      # Detects OpenTelemetry Resource attributes from git.
      module Git
        module_function

        GIT_MAPPING = {
          'vcs.ref.head.name' => [:to_s, -> { Utils.git('rev-parse', '--abbrev-ref', 'HEAD') }],
          'vcs.ref.head.revision' => [:to_s, -> { Utils.git('rev-parse', 'HEAD') }],
          'vcs.repository.url.full' => [:to_s, -> { Utils.git('config', '--get', 'remote.origin.url') }],
          'vcs.repository.name' => [
            :to_s,
            lambda {
              url = Utils.git('config', '--get', 'remote.origin.url')
              Utils.repository_name_from_url(url) if url
            }
          ]
        }.freeze

        def detect
          return OpenTelemetry::SDK::Resources::Resource.create({}) if Utils.ci_provider.nil?

          attributes = Utils.get_attributes(GIT_MAPPING)
          OpenTelemetry::SDK::Resources::Resource.create(attributes)
        end
      end
    end
  end
end
