# frozen_string_literal: true

require 'set'
require_relative 'utils'
require_relative 'native'
require_relative 'version'

module Mergify
  module RSpec
    # Signals that flaky detection must not run for this session, and that this
    # is expected rather than a failure: the repository has not opted in (the
    # server responds with 404) or there is no baseline of recorded tests yet.
    # Callers skip silently instead of surfacing an error banner.
    class FlakyDetectionDisabledError < StandardError; end

    # Manages intelligent test rerunning with budget constraints for flaky detection.
    # rubocop:disable-next Metrics/ClassLength
    class FlakyDetector
      # Per-test tracking metrics.
      class TestMetrics
        attr_accessor :initial_setup_duration, :initial_call_duration, :initial_teardown_duration,
                      :rerun_count, :deadline, :prevented_timeout, :total_duration

        def initialize
          @initial_setup_duration = 0.0
          @initial_call_duration = 0.0
          @initial_teardown_duration = 0.0
          @rerun_count = 0
          @deadline = nil
          @prevented_timeout = false
          @total_duration = 0.0
        end

        def initial_duration
          @initial_setup_duration + @initial_call_duration + @initial_teardown_duration
        end

        def remaining_time
          return 0.0 if @deadline.nil?

          [(@deadline - Time.now.to_f), 0.0].max
        end

        def will_exceed_deadline?
          return false if @deadline.nil?

          (Time.now.to_f + initial_duration) >= @deadline
        end

        def fill_from_report(phase, duration, _status)
          case phase
          when 'setup'
            @initial_setup_duration = duration if @initial_setup_duration.zero?
          when 'call'
            @initial_call_duration = duration if @initial_call_duration.zero?
            @rerun_count += 1
          when 'teardown'
            @initial_teardown_duration = duration if @initial_teardown_duration.zero?
          end
          @total_duration += duration
        end
      end

      attr_reader :tests_to_process, :budget, :mode

      def initialize(token:, url:, full_repository_name:, mode:)
        @token = token
        @url = url
        @full_repository_name = full_repository_name
        @mode = mode
        @metrics = {}
        @over_length_tests = Set.new
        @tests_to_process = []
        @budget = 0.0

        @context = fetch_context
        raise FlakyDetectionDisabledError unless Native::Budget.should_run(@context, @mode)
      end

      # Which tests this session reruns, and how long it may spend doing it,
      # both come from the shared budget engine -- so a Ruby suite and a Python
      # one facing the same context spend the same time.
      #
      # The engine sizes the budget from the existing tests *in this session*,
      # where this class counted every existing test the context knew about. A
      # session running part of a suite was handed the whole suite's budget; it
      # now gets its own.
      def prepare_for_session(test_ids)
        plan = Native::Budget.compute(@context, @mode, test_ids, [])

        @tests_to_process = plan['tests_to_process']
        # The engine works in milliseconds; everything downstream compares
        # against RSpec's durations, which are seconds.
        @budget = plan['available_budget_ms'] / 1000.0
      end

      # rubocop:disable-next Metrics/MethodLength
      def fill_metrics_from_report(test_id, phase, duration, status)
        if status == :skipped
          @metrics.delete(test_id)
          return
        end

        return unless @tests_to_process.include?(test_id)

        if test_id.length > @context['max_test_name_length']
          @over_length_tests.add(test_id)
          return
        end

        # Only initialize metrics when the first phase is "setup"
        return if !@metrics.key?(test_id) && phase != 'setup'

        @metrics[test_id] ||= TestMetrics.new
        @metrics[test_id].fill_from_report(phase, duration, status)
      end

      def rerunning_test?(test_id)
        @metrics.key?(test_id) && @metrics[test_id].rerun_count >= 1
      end

      def test_rerun?(test_id)
        @metrics.key?(test_id) && @metrics[test_id].rerun_count > 1
      end

      def set_test_deadline(test_id, timeout: nil)
        return unless @metrics.key?(test_id)

        remaining_tests = [remaining_tests_count, 1].max
        per_test_budget = remaining_budget / remaining_tests

        allocated =
          if timeout
            [per_test_budget, timeout * 0.9].min
          else
            per_test_budget
          end

        @metrics[test_id].deadline = Time.now.to_f + allocated
      end

      def test_too_slow?(test_id)
        return false unless @metrics.key?(test_id)

        metrics = @metrics[test_id]
        min_exec = @context['min_test_execution_count']
        (metrics.initial_duration * min_exec) > metrics.remaining_time
      end

      def last_rerun_for_test?(test_id)
        return false unless @metrics.key?(test_id)

        metrics = @metrics[test_id]
        metrics.will_exceed_deadline? || metrics.rerun_count >= @context['max_test_execution_count']
      end

      def test_metrics(test_id)
        @metrics[test_id]
      end

      # rubocop:disable-next Metrics/MethodLength,Metrics/AbcSize
      def make_report
        lines = []
        lines << 'Mergify Flaky Detection Report'
        lines << "  Mode        : #{@mode}"
        lines << "  Budget      : #{format('%.2f', @budget)}s"
        lines << "  Budget used : #{format('%.2f', budget_used)}s"
        lines << "  Tests tracked: #{@metrics.size}"
        lines << ''

        @metrics.each do |test_id, m|
          lines << "  #{test_id}"
          lines << "    Reruns       : #{m.rerun_count}"
          lines << "    Initial dur  : #{format('%.3f', m.initial_duration)}s"
          lines << "    Total dur    : #{format('%.3f', m.total_duration)}s"
          lines << "    Timeout warn : #{m.prevented_timeout}" if m.prevented_timeout
        end

        lines << '' unless @over_length_tests.empty?
        @over_length_tests.each do |id|
          lines << "  WARNING: test name too long (skipped): #{id[0, 80]}..."
        end

        lines.join("\n")
      end

      private

      # A nil context means the repository has not opted into flaky detection,
      # which is the expected default rather than a failure.
      def fetch_context
        raise FlakyDetectionDisabledError unless Native.available?

        owner, repo = Utils.split_full_repo_name(@full_repository_name)
        context = Native::Client.new(@url, @token, owner, repo, VERSION).fetch_flaky_context
        raise FlakyDetectionDisabledError if context.nil?

        context
      end

      def remaining_budget
        used = budget_used
        [@budget - used, 0.0].max
      end

      def budget_used
        @metrics.sum { |_, m| m.total_duration }
      end

      def remaining_tests_count
        @tests_to_process.count { |id| !@metrics.key?(id) || @metrics[id].deadline.nil? }
      end
    end
  end
end
