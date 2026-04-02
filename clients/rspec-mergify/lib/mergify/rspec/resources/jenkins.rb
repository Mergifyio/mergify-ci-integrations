# frozen_string_literal: true

require 'opentelemetry-sdk'
require_relative '../utils'
require_relative 'git'

module Mergify
  module RSpec
    module Resources
      # Detects OpenTelemetry Resource attributes for Jenkins.
      module Jenkins
        module_function

        GIT_BRANCH_PREFIXES = %w[origin/ refs/heads/].freeze

        JENKINS_MAPPING = {
          'cicd.pipeline.name' => [:to_s, 'JOB_NAME'],
          'cicd.pipeline.task.name' => [:to_s, 'JOB_NAME'],
          'cicd.pipeline.run.id' => [:to_s, 'BUILD_ID'],
          'cicd.pipeline.run.url' => [:to_s, 'BUILD_URL'],
          'cicd.pipeline.runner.name' => [:to_s, 'NODE_NAME'],
          'vcs.ref.head.name' => [:to_s, -> { branch }],
          'vcs.ref.head.revision' => [:to_s, 'GIT_COMMIT'],
          'vcs.repository.url.full' => [:to_s, 'GIT_URL'],
          'vcs.repository.name' => [
            :to_s,
            lambda {
              url = ENV.fetch('GIT_URL', nil)
              Utils.repository_name_from_url(url) if url
            }
          ]
        }.freeze

        def detect
          return OpenTelemetry::SDK::Resources::Resource.create({}) if Utils.ci_provider != :jenkins

          git_attrs = Utils.get_attributes(Git::GIT_MAPPING)
          jenkins_attrs = Utils.get_attributes(JENKINS_MAPPING)
          merged = git_attrs.merge(jenkins_attrs)
          OpenTelemetry::SDK::Resources::Resource.create(merged)
        end

        def branch
          raw = ENV.fetch('GIT_BRANCH', nil)
          return nil unless raw

          GIT_BRANCH_PREFIXES.each do |prefix|
            return raw[prefix.length..] if raw.start_with?(prefix)
          end
          raw
        end
      end
    end
  end
end
