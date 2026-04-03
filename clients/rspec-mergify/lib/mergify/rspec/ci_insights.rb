# frozen_string_literal: true

require 'securerandom'
require 'opentelemetry-sdk'
require_relative 'utils'
require_relative 'synchronous_batch_span_processor'
require_relative 'resources/ci'
require_relative 'resources/git'
require_relative 'resources/github_actions'
require_relative 'resources/jenkins'
require_relative 'resources/mergify'
require_relative 'resources/rspec'

module Mergify
  module RSpec
    # Central orchestrator for Mergify Test Insights: sets up OpenTelemetry tracing,
    # manages the tracer provider, and coordinates flaky detection and quarantine.
    # rubocop:disable Metrics/ClassLength
    class CIInsights
      attr_reader :token, :repo_name, :api_url, :test_run_id,
                  :tracer_provider, :tracer, :exporter,
                  :branch_name,
                  :flaky_detector, :flaky_detector_error_message, :quarantined_tests

      # rubocop:disable Metrics/MethodLength
      def initialize
        @token = ENV.fetch('MERGIFY_TOKEN', nil)
        @repo_name = Utils.repository_name
        @api_url = ENV.fetch('MERGIFY_API_URL', 'https://api.mergify.com')
        @test_run_id = SecureRandom.hex(8)
        @tracer_provider = nil
        @tracer = nil
        @exporter = nil
        @branch_name = nil
        @flaky_detector = nil
        @flaky_detector_error_message = nil
        @quarantined_tests = nil

        setup_tracing if Utils.in_ci?
      end
      # rubocop:enable Metrics/MethodLength

      def mark_test_as_quarantined_if_needed(example_id) # rubocop:disable Naming/PredicateMethod
        return false unless @quarantined_tests&.include?(example_id)

        @quarantined_tests.mark_as_used(example_id)
        true
      end

      private

      def setup_tracing
        processor, exp = build_processor
        return unless processor

        @exporter = exp
        resource = build_resource
        @tracer_provider = OpenTelemetry::SDK::Trace::TracerProvider.new(resource: resource)
        @tracer_provider.add_span_processor(processor)
        @tracer = @tracer_provider.tracer('rspec-mergify', Mergify::RSpec::VERSION)
        @branch_name = extract_branch_name(resource)
        load_flaky_detector
        load_quarantine
      end

      def build_processor
        if debug_mode? || test_mode?
          build_in_memory_processor
        elsif @token && @repo_name
          build_otlp_processor
        else
          [nil, nil]
        end
      end

      def debug_mode?
        ENV.key?('RSPEC_MERGIFY_DEBUG')
      end

      def test_mode?
        ENV['_RSPEC_MERGIFY_TEST'] == 'true'
      end

      def build_in_memory_processor
        exp = OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new
        processor = OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(exp)
        [processor, exp]
      end

      def build_otlp_processor
        owner, repo = Utils.split_full_repo_name(@repo_name)
        endpoint = "#{@api_url}/v1/ci/#{owner}/repositories/#{repo}/traces"
        exp = create_otlp_exporter(endpoint)
        processor = SynchronousBatchSpanProcessor.new(exp)
        [processor, exp]
      end

      # rubocop:disable Metrics/MethodLength
      def build_resource
        resources = [
          Resources::CI.detect,
          Resources::Git.detect,
          Resources::GitHubActions.detect,
          Resources::Jenkins.detect,
          Resources::Mergify.detect,
          Resources::RSpec.detect
        ]
        base = resources.reduce(OpenTelemetry::SDK::Resources::Resource.create({})) do |merged, r|
          merged.merge(r)
        end
        run_id_resource = OpenTelemetry::SDK::Resources::Resource.create('test.run.id' => @test_run_id)
        base.merge(run_id_resource)
      end
      # rubocop:enable Metrics/MethodLength

      def extract_branch_name(resource)
        attrs = resource.attribute_enumerator.to_h
        @base_branch_name = attrs['vcs.ref.base.name']
        @base_branch_name || attrs['vcs.ref.head.name']
      end

      # rubocop:disable Metrics/MethodLength
      def create_otlp_exporter(endpoint)
        require 'opentelemetry-exporter-otlp'
        original_env = ENV.fetch('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT', nil)
        ENV['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = endpoint
        begin
          OpenTelemetry::Exporter::OTLP::Exporter.new(
            endpoint: endpoint,
            headers: { 'Authorization' => "Bearer #{@token}" },
            compression: 'gzip'
          )
        ensure
          if original_env
            ENV['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] = original_env
          else
            ENV.delete('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT')
          end
        end
      end
      # rubocop:enable Metrics/MethodLength

      # rubocop:disable Metrics/MethodLength
      def load_flaky_detector
        return unless @token && @repo_name
        return unless Utils.env_truthy?('_MERGIFY_TEST_NEW_FLAKY_DETECTION')

        require_relative 'flaky_detection'
        mode = @base_branch_name ? 'new' : 'unhealthy'
        @flaky_detector = FlakyDetector.new(
          token: @token,
          url: @api_url,
          full_repository_name: @repo_name,
          mode: mode
        )
      rescue StandardError => e
        @flaky_detector_error_message = "Could not load flaky detector: #{e.message}"
      end
      # rubocop:enable Metrics/MethodLength

      def load_quarantine
        return unless @token && @repo_name && @branch_name

        require_relative 'quarantine'
        @quarantined_tests = Quarantine.new(
          api_url: @api_url,
          token: @token,
          repo_name: @repo_name,
          branch_name: @branch_name
        )
      end
    end
    # rubocop:enable Metrics/ClassLength
  end
end
