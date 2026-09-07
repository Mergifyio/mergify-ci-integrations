# frozen_string_literal: true

require 'json'
require 'opentelemetry-sdk'
require_relative '../utils'

module Mergify
  module RSpec
    module Resources
      # Detects OpenTelemetry Resource attributes for GitHub Actions.
      module GitHubActions
        module_function

        def detect
          return OpenTelemetry::SDK::Resources::Resource.create({}) if Utils.ci_provider != :github_actions

          attributes = Utils.get_attributes(GHA_MAPPING)
          OpenTelemetry::SDK::Resources::Resource.create(attributes)
        end

        GHA_MAPPING = {
          'cicd.pipeline.name' => [:to_s, 'GITHUB_WORKFLOW'],
          'cicd.pipeline.task.name' => [:to_s, 'GITHUB_JOB'],
          'cicd.pipeline.run.id' => [:to_i, 'GITHUB_RUN_ID'],
          'cicd.pipeline.run.attempt' => [:to_i, 'GITHUB_RUN_ATTEMPT'],
          'cicd.pipeline.runner.name' => [:to_s, 'RUNNER_NAME'],
          'vcs.ref.head.name' => [:to_s, -> { head_ref_name }],
          'vcs.ref.head.type' => [:to_s, 'GITHUB_REF_TYPE'],
          'vcs.ref.base.name' => [:to_s, 'GITHUB_BASE_REF'],
          'vcs.repository.name' => [:to_s, 'GITHUB_REPOSITORY'],
          'vcs.repository.id' => [:to_i, 'GITHUB_REPOSITORY_ID'],
          'vcs.repository.url.full' => [:to_s, -> { repository_url }],
          'vcs.ref.head.revision' => [:to_s, -> { head_sha }]
        }.freeze

        def head_ref_name
          ref = ENV.fetch('GITHUB_HEAD_REF', '')
          ref.empty? ? ENV.fetch('GITHUB_REF_NAME', nil) : ref
        end

        def repository_url
          server = ENV.fetch('GITHUB_SERVER_URL', nil)
          repo = ENV.fetch('GITHUB_REPOSITORY', nil)
          "#{server}/#{repo}" if server && repo
        end

        def head_sha
          if ENV.fetch('GITHUB_EVENT_NAME', nil) == 'pull_request'
            event_path = ENV.fetch('GITHUB_EVENT_PATH', nil)
            if event_path && File.file?(event_path)
              event = JSON.parse(File.read(event_path))
              return event.dig('pull_request', 'head', 'sha').to_s
            end
          end
          ENV.fetch('GITHUB_SHA', nil)
        end
      end
    end
  end
end
