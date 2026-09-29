# frozen_string_literal: true

require_relative 'test_selection'

module Mergify
  module RSpec
    # What the session concluded about each example, folded as RSpec reports
    # it, and written to Mergify when the session ends.
    #
    # Test Selection answers a merge-queue rerun from its predecessor's
    # verdict: which examples failed, whether anything ran at all. The verdict
    # is sent in one request before the trace upload, so the answer is there
    # seconds after the session ends rather than whenever trace ingestion gets
    # to it (INC-2434).
    #
    # One status per example, its FINAL one -- the status RSpec reported once
    # flaky detection's reruns were over, which is what decided the exit code.
    # A verdict that disagreed with the exit code would either replay examples
    # that did not gate, or skip the one that did.
    class SessionVerdict
      # A failure the quarantine absorbed is `quarantined_failed`: it did not
      # gate the job, so a rerun must not replay it, but it did run and fail,
      # so it is not green either.
      PRECEDENCE = { 'passed' => 0, 'skipped' => 1, 'quarantined_failed' => 2, 'failed' => 3 }.freeze

      # How sending went, for the report. `sent` is false both when nothing
      # had to be sent and when the request failed; `error` tells them apart.
      Result = Struct.new(:sent, :truncated, :error, keyword_init: true) do
        # Said only when the verdict did not reach Mergify whole. Wording
        # validated by Alexandre on 2026-09-15 (MRGFY-9313), pytest-mergify's
        # verbatim; a change here is a product decision.
        def report
          if error
            "#{TestSelection.wrap("Mergify couldn't record this run's results. If this merge-queue batch is " \
                                  'retried, this job will run its full test suite.')}\nError: #{error}\n"
          elsif truncated
            "#{TestSelection.wrap("Mergify recorded this run's counts but not its failing tests. If this " \
                                  'merge-queue batch is retried, this job will run its full test suite.')}\n"
          end
        end
      end

      def initialize
        @final = {}
        @runtime_seconds = 0.0
      end

      def record(example_id, status, run_time)
        @runtime_seconds += run_time.to_f
        previous = @final[example_id]
        @final[example_id] = status if previous.nil? || PRECEDENCE.fetch(status) > PRECEDENCE.fetch(previous)
      end

      def total_test_runtime_ms
        (@runtime_seconds * 1000).to_i
      end

      # The engine's own definitions: `executed` counts every example that
      # reached a status, a skipped one included, and `failed` includes the
      # quarantined failures.
      def counts
        statuses = @final.values
        {
          'executed_count' => statuses.size,
          'passed_count' => statuses.count('passed'),
          'failed_count' => statuses.count { |status| %w[failed quarantined_failed].include?(status) },
          'skipped_count' => statuses.count('skipped')
        }
      end

      def failing_tests
        ids_with('failed')
      end

      def quarantined_failing_tests
        ids_with('quarantined_failed')
      end

      private

      def ids_with(status)
        @final.filter_map { |id, final| id if final == status }
      end
    end
  end
end
