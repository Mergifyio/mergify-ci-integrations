# frozen_string_literal: true

require 'securerandom'
require_relative 'trace'
require_relative 'utils'
require_relative 'native'
require_relative 'resources/rspec'
require_relative 'test_selection'
require_relative 'session_verdict'

module Mergify
  module RSpec
    # Central orchestrator for Mergify Test Insights: records the run's spans,
    # uploads them, and coordinates flaky detection, quarantine and test
    # selection.
    # rubocop:disable-next Metrics/ClassLength
    class CIInsights
      # The resource attributes pytest-mergify reports, under the same keys.
      # The fingerprint and count describe what this run collected, on every
      # run that took one; the selection keys echo what Mergify answered, as
      # sent, and are absent on a run it never answered.
      TEST_COLLECTION_FINGERPRINT = 'test.collection.fingerprint'
      TEST_COLLECTION_COUNT = 'test.collection.count'
      TEST_SELECTION_ANSWER = 'test.selection.answer'
      TEST_SELECTION_REASON = 'test.selection.reason'
      TEST_SELECTION_KEPT_COUNT = 'test.selection.kept_count'
      TEST_SELECTION_NOT_APPLIED_REASON = 'test.selection.not_applied_reason'

      # The largest value the engine's counters take (a signed 32-bit int).
      MAX_COUNT = (2**31) - 1

      attr_reader :token, :repo_name, :api_url, :test_run_id,
                  :recorder,
                  :branch_name,
                  :flaky_detector, :flaky_detector_error_message, :quarantined_tests,
                  :test_selection, :session_verdict, :session_verdict_result,
                  :captured_session_verdict, :session_verdict_withheld

      # rubocop:disable-next Metrics/MethodLength,Metrics/AbcSize
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
        @test_selection = nil
        @selection_echo = nil
        @session_verdict = SessionVerdict.new
        @session_verdict_result = SessionVerdict::Result.new(sent: false, truncated: false)
        @captured_session_verdict = nil
        @session_verdict_withheld = false

        setup_tracing if Utils.in_ci?
      end

      # Take the identity of what this run is about to execute, and ask
      # Mergify whether part of it is enough.
      #
      # Called once RSpec has loaded the spec files and applied every filter
      # of its own -- file and line arguments, `--tag`, `-e`, `--only-failures`
      # -- so the fingerprint describes this process's examples and nothing
      # else. A parallel_tests worker, or a CI job handed a slice of the spec
      # files, collects its own slice and so reports its own identity: the
      # engine matches each against the previous attempt of the same slice.
      #
      # The fingerprint is reported on every run that can take one, whether
      # or not this job opted into the selection, as pytest-mergify does.
      def on_examples_collected(example_ids)
        return unless @recorder && Native.available?

        fingerprint = Native.test_collection_fingerprint(example_ids)
        @recorder.resource_attributes[TEST_COLLECTION_FINGERPRINT] = fingerprint
        @recorder.resource_attributes[TEST_COLLECTION_COUNT] = example_ids.size
        # A process with nothing to run has nothing to reduce, and asking would
        # cost the job its next retry: every parallel worker left empty by a
        # filter reports the same empty-set fingerprint under the same job, and
        # Mergify refuses to choose between sessions it cannot tell apart.
        load_test_selection(fingerprint) unless example_ids.empty?
      end

      # Report what Mergify answered and what this run made of it, once the
      # answer has met the collection. Nothing is echoed unless Mergify
      # actually answered: a run that never asked, or whose question went
      # unanswered, was offered nothing.
      # rubocop:disable-next Metrics/MethodLength
      def on_selection_resolved(kept_count)
        return unless @recorder && @test_selection&.served?

        @selection_echo = {
          'answer' => @test_selection.selection,
          'reason' => @test_selection.reason,
          'kept_count' => kept_count
        }
        not_applied = @test_selection.not_applied_reason
        @selection_echo['not_applied_reason'] = not_applied if not_applied

        resource = @recorder.resource_attributes
        resource[TEST_SELECTION_ANSWER] = @selection_echo['answer']
        resource[TEST_SELECTION_REASON] = @selection_echo['reason']
        resource[TEST_SELECTION_KEPT_COUNT] = kept_count
        resource[TEST_SELECTION_NOT_APPLIED_REASON] = not_applied if not_applied
      end

      # Write what this session concluded to Mergify, before the spans go.
      #
      # Sent exactly when the selection was asked for -- including when that
      # request failed: the verdict is what the NEXT rerun of this job needs.
      # Withheld when the run failed outside any example (a failing
      # `after(:context)` or suite hook): its examples then read as passed,
      # and a verdict naming no failure would have the retry run nothing and
      # turn green on the same breakage. Without a verdict, the retry runs the
      # whole suite. Never raises.
      # rubocop:disable-next Metrics/MethodLength,Metrics/AbcSize,Metrics/CyclomaticComplexity,Metrics/PerceivedComplexity
      def send_session_verdict(failed_outside_examples:)
        return if @test_selection.nil?

        if failed_outside_examples
          @session_verdict_withheld = true
          return
        end

        body = session_verdict_body
        return if body.nil?

        if test_mode?
          @captured_session_verdict = body
          @session_verdict_result = SessionVerdict::Result.new(sent: true, truncated: false)
          return
        end

        if debug_mode?
          puts "MERGIFY SESSION VERDICT: #{body}"
          @session_verdict_result = SessionVerdict::Result.new(sent: true, truncated: false)
          return
        end

        receipt = api_client.send_session_verdict(body)
        # Dormant: the feature is not enabled for this repository, which the
        # selection block already says.
        return if receipt.nil?

        @session_verdict_result = SessionVerdict::Result.new(sent: true, truncated: receipt['truncated'])
      rescue StandardError => e
        # Broader than ApiError on purpose: a value the binding cannot marshal
        # raises something else, and a verdict must never cost the run.
        message = e.is_a?(Native::ApiError) ? e.message : "#{e.class}: #{e.message}"
        @session_verdict_result = SessionVerdict::Result.new(sent: false, truncated: false, error: message)
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

      # Opt-in, per job, and asked for only where the run's identity is
      # complete: the head branch and revision (a merge-queue draft branch on a
      # rerun) and the job coordinates, the very values each uploaded example
      # carries, so the server can match its records.
      # rubocop:disable-next Metrics/MethodLength,Metrics/AbcSize,Metrics/CyclomaticComplexity
      def load_test_selection(fingerprint)
        return unless TestSelection.enabled?
        # An empty token is what a fork or a bot pull request gets for a secret.
        return if @token.to_s.empty? || @repo_name.to_s.empty?

        resource = @recorder.resource_attributes
        branch = resource['vcs.ref.head.name']
        head_sha = resource['vcs.ref.head.revision']
        pipeline_name = resource['cicd.pipeline.name']
        job_name = job_name_from(resource)
        return if [branch, head_sha, pipeline_name, job_name].any? { |value| value.to_s.empty? }

        answer = api_client.fetch_test_selection(branch.to_s, head_sha.to_s, pipeline_name.to_s,
                                                 job_name.to_s, fingerprint)
        @test_selection = answer.nil? ? TestSelection.unanswered : TestSelection.served(answer)
      rescue Native::ApiError, Utils::InvalidRepositoryFullNameError => e
        @test_selection = TestSelection.unanswered(init_error_msg: e.message)
      end

      # `mergify.test.job.name` is the operator-set override; the provider's
      # own task name is the fallback. Same precedence as the other clients.
      def job_name_from(resource)
        override = resource['mergify.test.job.name']
        override.to_s.empty? ? resource['cicd.pipeline.task.name'] : override
      end

      # The verdict body, keyed on exactly what the selection call was keyed
      # on, so a verdict is found by what the asking run knows.
      # rubocop:disable-next Metrics/MethodLength,Metrics/AbcSize
      def session_verdict_body
        resource = @recorder.resource_attributes
        fingerprint = resource[TEST_COLLECTION_FINGERPRINT]
        head_sha = resource['vcs.ref.head.revision']
        pipeline_name = resource['cicd.pipeline.name']
        job_name = job_name_from(resource)
        return nil if [fingerprint, head_sha, pipeline_name, job_name].any? { |value| value.to_s.empty? }

        body = {
          'test_run_id' => @test_run_id,
          'head_sha' => head_sha.to_s,
          'pipeline_name' => pipeline_name.to_s,
          'job_name' => job_name.to_s,
          'collection_fingerprint' => fingerprint,
          'collection_count' => resource[TEST_COLLECTION_COUNT],
          'total_test_runtime_ms' => @session_verdict.total_test_runtime_ms,
          'failing_tests' => @session_verdict.failing_tests,
          'quarantined_failing_tests' => @session_verdict.quarantined_failing_tests
        }.merge(@session_verdict.counts)
        head_branch = resource['vcs.ref.head.name']
        body['head_branch'] = head_branch.to_s unless head_branch.to_s.empty?
        add_run_identity(body, resource)
        body['selection'] = @selection_echo.dup if @selection_echo
        body
      end

      # `run_attempt` only next to a `run_id`: the engine refuses an attempt of
      # nothing. An attempt the engine's counter cannot hold is left out
      # rather than refused.
      def add_run_identity(body, resource)
        run_id = resource['cicd.pipeline.run.id']
        return if run_id.to_s.empty?

        body['run_id'] = run_id.to_s
        attempt = resource['cicd.pipeline.run.attempt']
        body['run_attempt'] = attempt if attempt.is_a?(Integer) && attempt.between?(0, MAX_COUNT)
      end

      def api_client
        @api_client ||= begin
          owner, repo = Utils.split_full_repo_name(@repo_name)
          Native::Client.new(@api_url, @token, owner, repo, Mergify::RSpec::VERSION)
        end
      end

      # Recording is unconditional; whether the run is *uploaded* is what the
      # token and repository decide. Debug and test runs keep their spans and
      # send nothing, which is what they always did -- the difference is that
      # the collector is the same object either way instead of two processors.
      def setup_tracing
        resource = build_resource
        @recorder = Trace::Recorder.new(resource_attributes: resource,
                                        traceparent: ENV.fetch('MERGIFY_TRACEPARENT', nil))
        @uploads = uploadable?
        # Only a pull request has a base branch, and that is what puts flaky
        # detection in 'new' mode. GitHub Actions still sets GITHUB_BASE_REF on
        # every other event, to an empty string, so empty counts as absent.
        base_branch_name = resource['vcs.ref.base.name']
        @base_branch_name = base_branch_name unless base_branch_name.to_s.empty?
        @branch_name = @base_branch_name || resource['vcs.ref.head.name']
        load_flaky_detector
        load_quarantine
      end

      def debug_mode?
        ENV.key?('RSPEC_MERGIFY_DEBUG')
      end

      def test_mode?
        ENV['_RSPEC_MERGIFY_TEST'] == 'true'
      end

      # A run is uploaded when there is somewhere to upload it to and nothing
      # asking us not to: debug and test runs record and keep.
      def uploadable?
        return false if debug_mode? || test_mode?
        return false unless @token && @repo_name && Native.available?

        true
      end

      # The cicd.* and vcs.* attributes come from the Rust core, which every
      # Mergify test client shares, so a CI provider added there reaches every
      # client at once. What stays here is what only Ruby knows: the test
      # framework and its language, and the id this run invented for itself.
      def build_resource
        Native.detect_attributes
              .merge(Resources::RSpec.detect)
              .merge('test.run.id' => @test_run_id)
      end

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
