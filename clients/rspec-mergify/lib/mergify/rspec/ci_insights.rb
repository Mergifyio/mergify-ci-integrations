# frozen_string_literal: true

require 'securerandom'
require_relative 'trace'
require_relative 'utils'
require_relative 'native'
require_relative 'resources/rspec'

module Mergify
  module RSpec
    # Central orchestrator for Mergify Test Insights: sets up span recording,
    # manages the tracer provider, and coordinates flaky detection and quarantine.
    class CIInsights
      attr_reader :token, :repo_name, :api_url, :test_run_id,
                  :recorder,
                  :branch_name,
                  :flaky_detector, :flaky_detector_error_message, :quarantined_tests

      # rubocop:disable-next Metrics/MethodLength
      def initialize
        @token = ENV.fetch('MERGIFY_TOKEN', nil)
        @repo_name = Native.detect_repository_name
        @api_url = ENV.fetch('MERGIFY_API_URL', 'https://api.mergify.com')
        @test_run_id = SecureRandom.hex(8)
        @recorder = nil
        @uploads = false
        @branch_name = nil
        @flaky_detector = nil
        @flaky_detector_error_message = nil
        @quarantined_tests = nil

        setup_tracing if Utils.in_ci?
      end

      # Send the run, once, at the end. Failing to report a run is worth
      # saying out loud but never worth failing a suite that just passed,
      # so this answers with a message instead of raising.
      def flush
        return nil unless @recorder && @uploads
        return nil if @recorder.finished_spans.empty?

        owner, repo = Utils.split_full_repo_name(@repo_name)
        client = Native::Client.new(@api_url, @token, owner, repo, Mergify::RSpec::VERSION)
        client.upload_trace(@recorder.resource_attributes, @recorder.finished_spans.map(&:to_h))
        nil
      rescue Native::ApiError, Utils::InvalidRepositoryFullNameError => e
        e.message
      end

      def mark_test_as_quarantined_if_needed(example_id) # rubocop:disable Naming/PredicateMethod
        return false unless @quarantined_tests&.include?(example_id)

        @quarantined_tests.mark_as_used(example_id)
        true
      end

      private

      # Recording is unconditional; whether the run is *uploaded* is what the
      # token and repository decide. Debug and test runs keep their spans and
      # send nothing, which is what they always did -- the difference is that
      # the collector is the same object either way instead of two processors.
      def setup_tracing
        resource = build_resource
        @recorder = Trace::Recorder.new(resource_attributes: resource,
                                        traceparent: ENV.fetch('MERGIFY_TRACEPARENT', nil))
        @uploads = uploadable?
        @branch_name = resource['vcs.ref.base.name'] || resource['vcs.ref.head.name']
        load_flaky_detector
        load_quarantine
      end

      def debug_mode?
        ENV.key?('RSPEC_MERGIFY_DEBUG')
      end

      def test_mode?
        ENV['_RSPEC_MERGIFY_TEST'] == 'true'
      end

      # The cicd.* and vcs.* attributes come from the Rust core, which every
      # Mergify test client shares, so a provider gains them everywhere at once.
      # What stays here is what only Ruby knows: the test framework, and the id
      # this run invented for itself.
      # The cicd.* and vcs.* attributes come from the Rust core, which every
      # Mergify test client shares. What stays here is what only Ruby knows:
      # the test framework, and the id this run invented for itself.
      # A run is uploaded when there is somewhere to upload it to and nothing
      # asking us not to: debug and test runs record and keep.
      def uploadable?
        return false if debug_mode? || test_mode?
        return false unless @token && @repo_name && Native.available?

        true
      end

      def build_resource
        Native.detect_attributes
              .merge(Resources::RSpec.detect)
              .merge('test.run.id' => @test_run_id)
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
