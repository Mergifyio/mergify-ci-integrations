# frozen_string_literal: true

require 'set'

module Mergify
  module RSpec
    # Registers RSpec hooks for quarantine and flaky detection, and adds the
    # CI Insights formatter when running inside CI.
    module Configuration
      module_function

      # rubocop:disable Metrics/MethodLength,Metrics/BlockLength,Metrics/AbcSize
      # rubocop:disable Metrics/CyclomaticComplexity,Metrics/PerceivedComplexity
      def setup!
        ::RSpec.configure do |config|
          # Add formatter when in CI
          config.add_formatter(Mergify::RSpec::Formatter) if Utils.in_ci?

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
            ci = Mergify::RSpec.ci_insights
            fd = ci&.flaky_detector

            example.run

            # Feed metrics from the initial run so the detector can evaluate
            if fd
              run_time = example.execution_result.run_time || 0.0
              status = example.execution_result.status
              fd.fill_metrics_from_report(example.id, 'setup', 0.0, status)
              fd.fill_metrics_from_report(example.id, 'call', run_time, status)
              fd.fill_metrics_from_report(example.id, 'teardown', 0.0, status)
            end

            next unless fd&.rerunning_test?(example.id)

            # Mark as flaky detection candidate (even if too slow to rerun)
            example.metadata[:mergify_flaky_detection] = true
            example.metadata[:mergify_new_test] = true if fd.mode == 'new'

            fd.set_test_deadline(example.id)
            next if fd.test_too_slow?(example.id)

            distinct_outcomes = Set.new
            distinct_outcomes.add(example.execution_result.status) if example.execution_result.status

            rerun_count = 0
            until example.metadata[:is_last_rerun]
              example.metadata[:is_last_rerun] = fd.last_rerun_for_test?(example.id)

              # Reset example state for rerun
              example.instance_variable_set(:@exception, nil)
              if example.example_group_instance
                memoized = example.example_group_instance.instance_variable_get(:@__memoized)
                memoized&.clear
              end

              example.run
              distinct_outcomes.add(example.execution_result.status)
              rerun_count += 1
            end

            is_flaky = distinct_outcomes.include?(:passed) &&
                       distinct_outcomes.include?(:failed)
            example.metadata[:mergify_flaky] = true if is_flaky
            example.metadata[:mergify_rerun_count] = rerun_count
          end

          # Quarantine: override failed quarantined test results
          config.after(:each) do |example|
            next unless example.metadata[:mergify_quarantined] && example.exception

            example.instance_variable_set(:@exception, nil)
            example.execution_result.status = :pending
            example.execution_result.pending_message = 'Test is quarantined from Mergify CI Insights'
          end
        end
      end
      # rubocop:enable Metrics/CyclomaticComplexity,Metrics/PerceivedComplexity
      # rubocop:enable Metrics/MethodLength,Metrics/BlockLength,Metrics/AbcSize
    end
  end
end
