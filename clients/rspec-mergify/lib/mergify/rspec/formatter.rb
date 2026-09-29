# frozen_string_literal: true

require 'rspec/core/formatters/base_formatter'
require_relative 'trace'
require_relative 'configuration'

require 'mergify/rspec/native'

module Mergify
  module RSpec
    # RSpec formatter that records spans for Mergify Test Insights and
    # prints a terminal report. It is purely observational and does not modify
    # test execution.
    # rubocop:disable-next Metrics/ClassLength
    class Formatter < ::RSpec::Core::Formatters::BaseFormatter
      # What it listens to once attached, `start` excepted: it is attached after
      # that notification, and handed it directly.
      NOTIFICATIONS = %i[example_started example_finished example_pending stop].freeze

      # @mergifyio/vitest's sentence, for the same withheld verdict.
      WITHHELD_VERDICT = TestSelection.wrap(
        "Mergify wasn't sent this run's results: it failed outside any example. If this merge-queue " \
        'batch is retried, this job will run its full test suite.'
      )

      ::RSpec::Core::Formatters.register self, :start, *NOTIFICATIONS

      def start(notification)
        super

        @ci_insights = Mergify::RSpec.ci_insights
        return unless @ci_insights&.recorder

        @session_span = @ci_insights.recorder.start_span(
          'rspec session start',
          attributes: { 'test.scope' => 'session' }
        )
        @has_error = false
        @example_spans = {}
      end

      def example_started(notification)
        return unless @ci_insights&.recorder && @session_span

        example = notification.example
        quarantined = @ci_insights.mark_test_as_quarantined_if_needed(example.id)

        span = @ci_insights.recorder.start_span(
          example.id,
          parent: @session_span,
          attributes: build_example_attributes(example, quarantined)
        )
        @example_spans[example.id] = span
      end

      # rubocop:disable-next Metrics/MethodLength,Metrics/AbcSize
      def example_finished(notification)
        return unless @example_spans

        example = notification.example
        span = @example_spans.delete(example.id)
        return unless span

        result = example.execution_result
        @ci_insights.session_verdict.record(example.id, verdict_status(example), result.run_time)
        status = result.status.to_s
        span.set_attribute('test.case.result.status', status)
        set_flaky_attributes(span, example)

        if result.status == :failed
          set_error_attributes(span, result.exception)
          @has_error = true
        else
          span.ok!
        end

        @ci_insights.recorder.record(span)
      end

      def example_pending(notification)
        return unless @example_spans

        example = notification.example
        span = @example_spans.delete(example.id)
        return unless span

        span.set_attribute('test.case.result.status', 'skipped')
        @ci_insights.session_verdict.record(example.id, verdict_status(example), example.execution_result.run_time)
        @ci_insights.recorder.record(span)
      end

      def stop(_notification)
        finish_session_span
        # The verdict first, on purpose: it is what the next merge-queue rerun
        # of this job is answered from, and it must never wait behind the
        # trace upload's timeout and retries.
        send_session_verdict
        print_report
        flush_and_shutdown
      end

      private

      # The status RSpec reported, which is the one that decided the exit
      # code. A pending example is a skip, unless it is a failure the
      # quarantine absorbed.
      def verdict_status(example)
        result = example.execution_result
        case result.status
        when :passed then 'passed'
        when :failed then 'failed'
        else
          quarantined = example.metadata[:mergify_quarantined] &&
                        result.pending_message == Configuration::QUARANTINE_MESSAGE
          quarantined ? 'quarantined_failed' : 'skipped'
        end
      end

      def send_session_verdict
        return unless @ci_insights&.recorder

        @ci_insights.send_session_verdict(failed_outside_examples: failed_outside_examples?)
      end

      # RSpec flags a failure no example carries -- a failing `after(:context)`
      # or suite hook. A load error flags it too, but stops the run before the
      # formatter is ever attached.
      def failed_outside_examples?
        ::RSpec.world.non_example_failure ? true : false
      end

      def build_example_attributes(example, quarantined)
        {
          'test.scope' => 'case',
          'code.filepath' => example.metadata[:file_path].delete_prefix('./'),
          'code.function' => example.description,
          'code.lineno' => example.metadata[:line_number] || 0,
          'code.namespace' => example.example_group.description,
          'code.file.path' => File.expand_path(example.metadata[:file_path]),
          'code.line.number' => example.metadata[:line_number] || 0,
          'cicd.test.quarantined' => quarantined
        }
      end

      def set_flaky_attributes(span, example)
        meta = example.metadata

        rerun_count = meta[:mergify_rerun_count]
        span.set_attribute('cicd.test.rerun_count', rerun_count) unless rerun_count.nil?

        flaky = meta[:mergify_flaky]
        span.set_attribute('cicd.test.flaky', flaky) unless flaky.nil?

        flaky_detection = meta[:mergify_flaky_detection]
        span.set_attribute('cicd.test.flaky_detection', flaky_detection) unless flaky_detection.nil?

        new_test = meta[:mergify_new_test]
        span.set_attribute('cicd.test.new', new_test) unless new_test.nil?
      end

      def set_error_attributes(span, exception)
        span.set_attribute('exception.type', exception.class.to_s)
        span.set_attribute('exception.message', exception.message)
        span.set_attribute('exception.stacktrace', exception.backtrace&.join("\n") || '')
        span.error!(exception.message)
      end

      def finish_session_span
        return unless @session_span

        if @has_error
          @session_span.error!('One or more tests failed')
        else
          @session_span.ok!
        end
        @ci_insights.recorder.record(@session_span)
      end

      # rubocop:disable-next Metrics/MethodLength
      def print_report
        output.puts ''
        output.puts '--- Mergify CI ---'

        unless @ci_insights
          output.puts 'Mergify Test Insights is not configured.'
          return
        end

        print_configuration_warnings
        print_flaky_report
        print_quarantine_report
        print_test_selection_report
        output.puts "MERGIFY_TEST_RUN_ID=#{@ci_insights.test_run_id}"
        output.puts '------------------'
      end

      def print_configuration_warnings
        output.puts 'WARNING: MERGIFY_TOKEN is not set. Traces will not be sent to Mergify.' unless @ci_insights.token

        return print_native_warning unless Mergify::RSpec::Native.available?
        return if @ci_insights.repo_name

        output.puts 'WARNING: Could not detect repository name. ' \
                    'Please set GITHUB_REPOSITORY or configure a git remote.'
      end

      # The extension is what detects CI, so when it did not load there is no
      # repository name either, and blaming that would send people hunting for a
      # git remote that is fine. Say what actually happened instead.
      def print_native_warning
        output.puts 'WARNING: the Mergify native extension could not be loaded, so this run reports nothing: ' \
                    "#{Mergify::RSpec::Native.load_error&.message}"
      end

      def print_flaky_report
        return unless @ci_insights.flaky_detector.respond_to?(:make_report)

        report = @ci_insights.flaky_detector.make_report
        output.puts report if report
      end

      def print_quarantine_report
        return unless @ci_insights.quarantined_tests.respond_to?(:report)

        report = @ci_insights.quarantined_tests.report
        output.puts report if report
      end

      # One block whatever happened, once the job asked for a selection.
      def print_test_selection_report
        selection = @ci_insights.test_selection
        return unless selection

        output.puts selection.report
        output.puts WITHHELD_VERDICT if @ci_insights.session_verdict_withheld
        verdict_report = @ci_insights.session_verdict_result.report
        output.puts verdict_report if verdict_report
      end

      # One upload, at the end. There is nothing to shut down any more: the
      # recorder holds spans in memory and the client owns the connection.
      def flush_and_shutdown
        return unless @ci_insights&.recorder

        error = @ci_insights.flush
        print_export_error(StandardError.new(error)) if error
      end

      def print_export_error(error)
        output.puts "Error while exporting traces: #{error.message}"
        output.puts ''
        output.puts 'Common issues:'
        output.puts '  - Your MERGIFY_TOKEN might not be set or could be invalid'
        output.puts '  - Mergify Test Insights might not be enabled for this repository'
        output.puts '  - There might be a network connectivity issue with the Mergify API'
        output.puts ''
        output.puts 'Documentation: https://docs.mergify.com/ci-insights/test-frameworks/'
      end
    end
  end
end
