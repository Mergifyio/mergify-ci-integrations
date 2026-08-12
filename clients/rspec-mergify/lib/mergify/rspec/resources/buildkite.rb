# frozen_string_literal: true

require 'opentelemetry-sdk'
require_relative '../utils'
require_relative 'git'

module Mergify
  module RSpec
    module Resources
      # Detects OpenTelemetry Resource attributes for Buildkite.
      module Buildkite
        module_function

        BUILDKITE_MAPPING = {
          'cicd.pipeline.name' => [:to_s, 'BUILDKITE_PIPELINE_SLUG'],
          'cicd.pipeline.task.name' => [
            :to_s,
            lambda {
              label = ENV.fetch('BUILDKITE_LABEL', nil)
              label && !label.empty? ? label : ENV.fetch('BUILDKITE_STEP_KEY', nil)
            }
          ],
          'cicd.pipeline.run.id' => [:to_s, 'BUILDKITE_BUILD_ID'],
          'cicd.pipeline.run.url' => [:to_s, 'BUILDKITE_BUILD_URL'],
          'cicd.pipeline.run.attempt' => [
            :to_i,
            -> { ENV.fetch('BUILDKITE_RETRY_COUNT', '0').to_i + 1 }
          ],
          'cicd.pipeline.runner.name' => [:to_s, 'BUILDKITE_AGENT_NAME'],
          'vcs.ref.head.name' => [:to_s, 'BUILDKITE_BRANCH'],
          'vcs.ref.base.name' => [:to_s, 'BUILDKITE_PULL_REQUEST_BASE_BRANCH'],
          'vcs.ref.head.revision' => [:to_s, 'BUILDKITE_COMMIT'],
          'vcs.repository.url.full' => [:to_s, 'BUILDKITE_REPO'],
          'vcs.repository.name' => [
            :to_s,
            lambda {
              url = ENV.fetch('BUILDKITE_REPO', nil)
              Utils.repository_name_from_url(url) if url
            }
          ]
        }.freeze

        def detect
          return OpenTelemetry::SDK::Resources::Resource.create({}) if Utils.ci_provider != :buildkite

          git_attrs = Utils.get_attributes(Git::GIT_MAPPING)
          buildkite_attrs = Utils.get_attributes(BUILDKITE_MAPPING)
          merged = git_attrs.merge(buildkite_attrs)
          OpenTelemetry::SDK::Resources::Resource.create(merged)
        end
      end
    end
  end
end
