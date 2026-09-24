# frozen_string_literal: true

require 'set'

module Mergify
  module RSpec
    # Registers RSpec hooks for quarantine and flaky detection, and attaches the
    # Mergify Test Insights formatter when running inside CI.
    module Configuration
      module_function

      # rubocop:disable-next Metrics/MethodLength,Metrics/BlockLength,Metrics/AbcSize
      # rubocop:disable-next Metrics/CyclomaticComplexity,Metrics/PerceivedComplexity
      def setup!
        ::RSpec.configure do |config|
          # Attached to the reporter once the suite starts, rather than added with
          # `add_formatter`: RSpec only sets up its default formatter when no
          # other was added, so adding this one took the progress output and the
          # summary line away from every suite that had not chosen a format.
          config.prepend_before(:suite) { Configuration.attach_formatter(config) } if Utils.in_ci?

          # Flaky detection: prepare session with all example IDs
          config.before(:suite) do
            ci = Mergify::RSpec.ci_insights
            fd = ci&.flaky_detector
            if fd
              all_ids = ::RSpec.world.example_groups.flat_map(&:descendants).flat_map(&:examples).map(&:id)
              fd.prepare_for_session(all_ids)
            end
          end

          # Quarantine: mark tests before execution
          config.before(:each) do |example|
            ci = Mergify::RSpec.ci_insights
            next unless ci&.quarantined_tests&.include?(example.id)

            ci.quarantined_tests.mark_as_used(example.id)
            example.metadata[:mergify_quarantined] = true
          end

          # Flaky detection: rerun tests within budget
          config.around(:each) do |example|
            fd = Mergify::RSpec.ci_insights&.flaky_detector
            fd ? Configuration.run_detecting_flakiness(example, fd) : example.run
          end

          # Quarantine: override failed quarantined test results. The failure is
          # noted for flaky detection first, which would otherwise take a
          # quarantined attempt that failed for one that passed.
          config.after(:each) do |example|
            next unless example.metadata[:mergify_quarantined] && example.exception

            example.metadata[:mergify_quarantined_failure] = true
            example.instance_variable_set(:@exception, nil)
            example.execution_result.status = :pending
            example.execution_result.pending_message = 'Test is quarantined from Mergify Test Insights'
          end
        end
      end

      # The reporter has sent `start` by the time suite hooks run, so the
      # formatter is handed the same notification directly.
      def attach_formatter(config)
        formatter = Formatter.new(config.output_stream)
        formatter.start(::RSpec::Core::Notifications::StartNotification.new(::RSpec.world.example_count, 0))
        config.reporter.register_listener(formatter, *Formatter::NOTIFICATIONS)
      end

      # `example` is the Procsy an around hook is handed, and the example has no
      # result yet: RSpec records its status and run time in `Example#finish`,
      # once every around hook has returned. So each attempt is timed here, and
      # its outcome read off the exception it left behind.
      # rubocop:disable-next Metrics/AbcSize
      def run_detecting_flakiness(example, detector)
        status, duration = run_attempt(example)
        detector.fill_metrics_from_report(example.id, 'setup', 0.0, status)
        detector.fill_metrics_from_report(example.id, 'call', duration, status)
        detector.fill_metrics_from_report(example.id, 'teardown', 0.0, status)
        return unless detector.rerunning_test?(example.id)

        # Mark as flaky detection candidate (even if too slow to rerun)
        example.metadata[:mergify_flaky_detection] = true
        example.metadata[:mergify_new_test] = true if detector.mode == 'new'

        detector.set_test_deadline(example.id)
        return if detector.test_too_slow?(example.id)

        rerun(example, detector, status)
      end

      # Which attempt decides the result is pytest-mergify's rule: in 'new' mode
      # any failure fails the test, so a new flaky test cannot be merged; in
      # 'unhealthy' mode the reruns only learn, and the first attempt stands.
      # rubocop:disable-next Metrics/MethodLength,Metrics/AbcSize
      def rerun(example, detector, initial_status)
        initial_exception = example.exception
        first_failure = initial_exception
        outcomes = Set[initial_status]
        rerun_count = 0

        until example.metadata[:is_last_rerun]
          example.metadata[:is_last_rerun] = detector.last_rerun_for_test?(example.id)
          reset_for_rerun(example)

          status, duration = run_attempt(example)
          detector.fill_metrics_from_report(example.id, 'call', duration, status)
          outcomes << status
          first_failure ||= example.exception
          rerun_count += 1
        end

        example.metadata[:mergify_flaky] = true if outcomes.include?(:passed) && outcomes.include?(:failed)
        example.metadata[:mergify_rerun_count] = rerun_count
        final_exception = detector.mode == 'new' ? first_failure : initial_exception
        example.example.instance_variable_set(:@exception, final_exception)
      end

      # Runs what the around hook wraps -- the before and after hooks included
      # -- and answers its outcome and duration in seconds.
      def run_attempt(example)
        started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        example.run
        duration = Process.clock_gettime(Process::CLOCK_MONOTONIC) - started
        failed = example.exception || example.metadata.delete(:mergify_quarantined_failure)
        [failed ? :failed : :passed, duration]
      end

      # The exception lives on the example itself, not on the Procsy: setting
      # it there would leave RSpec to fold every attempt's failure into one.
      def reset_for_rerun(example)
        example.example.instance_variable_set(:@exception, nil)
        return unless example.example_group_instance

        memoized = example.example_group_instance.instance_variable_get(:@__memoized)
        if memoized.respond_to?(:clear)
          memoized.clear
        elsif memoized
          # RSpec >= 3.12 uses ThreadsafeMemoized which wraps an internal hash
          memoized.instance_variable_get(:@memoized)&.clear
        end
      end
    end
  end
end
