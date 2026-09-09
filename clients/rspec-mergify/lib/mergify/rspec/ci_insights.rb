# frozen_string_literal: true

require 'securerandom'
require 'opentelemetry-sdk'
require_relative 'utils'
require_relative 'native'
require_relative 'synchronous_batch_span_processor'
require_relative 'rust_trace_exporter'
require_relative 'resources/rspec'

module Mergify
  module RSpec
    # Central orchestrator for Mergify Test Insights: sets up OpenTelemetry tracing,
    # manages the tracer provider, and coordinates flaky detection and quarantine.
    # rubocop:disable-next Metrics/ClassLength
    class CIInsights
      attr_reader :token, :repo_name, :api_url, :test_run_id,
                  :tracer_provider, :tracer, :exporter,
                  :branch_name,
                  :flaky_detector, :flaky_detector_error_message, :quarantined_tests

      # rubocop:disable-next Metrics/MethodLength
      def initialize
        @token = ENV.fetch('MERGIFY_TOKEN', nil)
        @repo_name = Native.detect_repository_name
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

      # The endpoint, the gzip, the retries and the size limit belong to the
      # shared client now; this only has to hand it the spans.
      def build_otlp_processor
        return [nil, nil] unless Native.available?

        owner, repo = Utils.split_full_repo_name(@repo_name)
        client = Native::Client.new(@api_url, @token, owner, repo, Mergify::RSpec::VERSION)
        exp = RustTraceExporter.new(client)
        [SynchronousBatchSpanProcessor.new(exp), exp]
      end

      # The cicd.* and vcs.* attributes come from the Rust core, which every
      # Mergify test client shares, so a provider gains them everywhere at once.
      # What stays here is what only Ruby knows: the test framework, and the id
      # this run invented for itself.
      def build_resource
        resources = [
          OpenTelemetry::SDK::Resources::Resource.create(Native.detect_attributes),
          Resources::RSpec.detect,
          OpenTelemetry::SDK::Resources::Resource.create('test.run.id' => @test_run_id)
        ]
        resources.reduce(OpenTelemetry::SDK::Resources::Resource.create({})) do |merged, r|
          merged.merge(r)
        end
      end

      def extract_branch_name(resource)
        attrs = resource.attribute_enumerator.to_h
        @base_branch_name = attrs['vcs.ref.base.name']
        @base_branch_name || attrs['vcs.ref.head.name']
      end

      # rubocop:disable-next Metrics/MethodLength
      # rubocop:disable-next Metrics/MethodLength
      def load_flaky_detector
        return unless @token && @repo_name

        require_relative 'flaky_detection'
        mode = @base_branch_name ? 'new' : 'unhealthy'
        @flaky_detector = FlakyDetector.new(
          token: @token,
          url: @api_url,
          full_repository_name: @repo_name,
          mode: mode
        )
      rescue FlakyDetectionDisabledError
        # The repository has not opted into flaky detection, or has no baseline
        # yet. Both are expected; skip without surfacing an error.
        nil
      rescue StandardError => e
        @flaky_detector_error_message = "Could not load flaky detector: #{e.message}"
      end

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
  end
end
