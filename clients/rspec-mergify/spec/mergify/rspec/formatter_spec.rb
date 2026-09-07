# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/ci_insights'
require 'mergify/rspec/formatter'

RSpec.describe Mergify::RSpec::Formatter do
  let(:exporter) { OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new }
  let(:output) { StringIO.new }
  let(:formatter) { described_class.new(output) }

  let(:ci_insights) do
    insights = instance_double(Mergify::RSpec::CIInsights)
    processor = OpenTelemetry::SDK::Trace::Export::SimpleSpanProcessor.new(exporter)
    tracer_provider = OpenTelemetry::SDK::Trace::TracerProvider.new
    tracer_provider.add_span_processor(processor)
    tracer = tracer_provider.tracer('rspec-mergify-test', '0.0.1')

    allow(insights).to receive_messages(
      tracer: tracer,
      tracer_provider: tracer_provider,
      token: 'test-token',
      repo_name: 'owner/repo',
      test_run_id: 'abc123',
      flaky_detector: nil,
      quarantined_tests: nil,
      mark_test_as_quarantined_if_needed: false
    )
    insights
  end

  def build_start_notification(count: 5)
    notification = instance_double(RSpec::Core::Notifications::StartNotification)
    allow(notification).to receive(:count).and_return(count)
    notification
  end

  def build_example_metadata(file_path:, line_number:)
    {
      file_path: file_path,
      line_number: line_number,
      mergify_rerun_count: nil,
      mergify_flaky: nil,
      mergify_flaky_detection: nil,
      mergify_new_test: nil
    }
  end

  def build_example(id: './spec/models/user_spec.rb[1:1]',
                    description: 'does something',
                    file_path: './spec/models/user_spec.rb',
                    line_number: 10,
                    group_description: 'User')
    example = instance_double(RSpec::Core::Example)
    # ExampleGroup is a class (not an instance), so we use a plain double
    example_group = double('ExampleGroup') # rubocop:disable RSpec/VerifiedDoubles
    allow(example_group).to receive(:description).and_return(group_description)
    allow(example).to receive_messages(
      id: id,
      description: description,
      example_group: example_group,
      metadata: build_example_metadata(file_path: file_path, line_number: line_number)
    )
    example
  end

  def build_example_notification(example)
    notification = instance_double(RSpec::Core::Notifications::ExampleNotification)
    allow(notification).to receive(:example).and_return(example)
    notification
  end

  def build_passed_execution_result
    result = instance_double(RSpec::Core::Example::ExecutionResult)
    allow(result).to receive_messages(status: :passed, exception: nil)
    result
  end

  def build_failed_execution_result(exception_message: 'expected true, got false')
    result = instance_double(RSpec::Core::Example::ExecutionResult)
    exception = instance_double(Exception)
    allow(exception).to receive_messages(message: exception_message, class: RSpec::Expectations::ExpectationNotMetError,
                                         backtrace: ['spec/foo_spec.rb:42:in `block`'])
    allow(result).to receive_messages(status: :failed, exception: exception)
    result
  end

  def build_stop_notification
    instance_double(RSpec::Core::Notifications::SummaryNotification)
  end

  before do
    allow(Mergify::RSpec).to receive(:ci_insights).and_return(ci_insights)
    allow(ci_insights).to receive(:tracer_provider).and_return(ci_insights.tracer_provider)
    # Suppress force_flush/shutdown
    allow(ci_insights.tracer_provider).to receive(:force_flush)
    allow(ci_insights.tracer_provider).to receive(:shutdown)
  end

  describe '#start' do
    it 'creates a session span' do
      formatter.start(build_start_notification)
      finished_spans = exporter.finished_spans
      # session span is not finished yet
      expect(finished_spans).to be_empty
      # but the formatter has set up the session span
      expect(formatter.instance_variable_get(:@session_span)).not_to be_nil
    end

    it 'initializes @has_error to false' do
      formatter.start(build_start_notification)
      expect(formatter.instance_variable_get(:@has_error)).to be(false)
    end

    it 'initializes @example_spans to an empty hash' do
      formatter.start(build_start_notification)
      expect(formatter.instance_variable_get(:@example_spans)).to eq({})
    end

    context 'when tracer is nil' do
      before do
        allow(ci_insights).to receive(:tracer).and_return(nil)
      end

      it 'returns early without creating a session span' do
        formatter.start(build_start_notification)
        expect(formatter.instance_variable_get(:@session_span)).to be_nil
      end
    end
  end

  describe '#example_started' do
    let(:example) { build_example }
    let(:notification) { build_example_notification(example) }

    before { formatter.start(build_start_notification) }

    it 'stores a span in @example_spans keyed by example id' do
      formatter.example_started(notification)
      expect(formatter.instance_variable_get(:@example_spans)).to have_key(example.id)
    end

    it 'does nothing when tracer is nil' do
      allow(ci_insights).to receive(:tracer).and_return(nil)
      formatter2 = described_class.new(output)
      formatter2.start(build_start_notification)
      formatter2.example_started(notification)
      expect(formatter2.instance_variable_get(:@example_spans)).to be_nil.or be_empty
    end
  end

  describe '#example_finished' do
    let(:example) { build_example }
    let(:notification) { build_example_notification(example) }

    before do
      formatter.start(build_start_notification)
      formatter.example_started(notification)
      allow(example).to receive(:execution_result).and_return(build_passed_execution_result)
    end

    it 'removes the span from @example_spans' do
      formatter.example_finished(notification)
      expect(formatter.instance_variable_get(:@example_spans)).not_to have_key(example.id)
    end

    it 'finishes the span (it appears in exporter)' do
      formatter.example_finished(notification)
      spans = exporter.finished_spans
      example_span = spans.find { |s| s.name == example.id }
      expect(example_span).not_to be_nil
    end

    it 'sets test.case.result.status to "passed" for a passing test' do
      formatter.example_finished(notification)
      span = exporter.finished_spans.find { |s| s.name == example.id }
      expect(span.attributes['test.case.result.status']).to eq('passed')
    end

    it 'sets span status to OK for a passing test' do
      formatter.example_finished(notification)
      span = exporter.finished_spans.find { |s| s.name == example.id }
      expect(span.status.code).to eq(OpenTelemetry::Trace::Status::OK)
    end

    it 'does not set @has_error for a passing test' do
      formatter.example_finished(notification)
      expect(formatter.instance_variable_get(:@has_error)).to be(false)
    end

    context 'with a failing test' do
      let(:failed_result) { build_failed_execution_result }

      before do
        allow(example).to receive(:execution_result).and_return(failed_result)
      end

      it 'sets test.case.result.status to "failed"' do
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['test.case.result.status']).to eq('failed')
      end

      it 'sets span status to ERROR' do
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.status.code).to eq(OpenTelemetry::Trace::Status::ERROR)
      end

      it 'sets @has_error to true' do
        formatter.example_finished(notification)
        expect(formatter.instance_variable_get(:@has_error)).to be(true)
      end

      it 'sets exception.message attribute' do
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['exception.message']).to eq('expected true, got false')
      end

      it 'sets exception.type attribute' do
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['exception.type']).to eq('RSpec::Expectations::ExpectationNotMetError')
      end
    end

    context 'with flaky detection metadata' do
      it 'sets cicd.test.flaky_detection when metadata is true' do
        example.metadata[:mergify_flaky_detection] = true
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['cicd.test.flaky_detection']).to be(true)
      end

      it 'sets cicd.test.new when metadata is true' do
        example.metadata[:mergify_new_test] = true
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['cicd.test.new']).to be(true)
      end

      it 'sets cicd.test.rerun_count from metadata' do
        example.metadata[:mergify_rerun_count] = 5
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['cicd.test.rerun_count']).to eq(5)
      end

      it 'sets cicd.test.flaky when metadata is true' do
        example.metadata[:mergify_flaky] = true
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['cicd.test.flaky']).to be(true)
      end

      it 'does not set flaky attributes when metadata is nil' do
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes).not_to have_key('cicd.test.flaky_detection')
        expect(span.attributes).not_to have_key('cicd.test.new')
        expect(span.attributes).not_to have_key('cicd.test.rerun_count')
        expect(span.attributes).not_to have_key('cicd.test.flaky')
      end
    end

    context 'with correct span attributes' do
      it 'sets test.scope attribute' do
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['test.scope']).to eq('case')
      end

      it 'sets code.filepath attribute' do
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['code.filepath']).to eq('spec/models/user_spec.rb')
      end

      it 'sets code.function attribute' do
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['code.function']).to eq('does something')
      end

      it 'sets code.lineno attribute' do
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['code.lineno']).to eq(10)
      end

      it 'sets code.namespace attribute' do
        formatter.example_finished(notification)
        span = exporter.finished_spans.find { |s| s.name == example.id }
        expect(span.attributes['code.namespace']).to eq('User')
      end
    end
  end

  describe '#example_pending' do
    let(:example) { build_example }
    let(:notification) { build_example_notification(example) }

    before do
      formatter.start(build_start_notification)
      formatter.example_started(notification)
      execution_result = instance_double(RSpec::Core::Example::ExecutionResult)
      allow(execution_result).to receive(:status).and_return(:pending)
      allow(example).to receive(:execution_result).and_return(execution_result)
    end

    it 'finishes the span with skipped status' do
      formatter.example_pending(notification)
      span = exporter.finished_spans.find { |s| s.name == example.id }
      expect(span).not_to be_nil
    end

    it 'sets test.case.result.status to "skipped"' do
      formatter.example_pending(notification)
      span = exporter.finished_spans.find { |s| s.name == example.id }
      expect(span.attributes['test.case.result.status']).to eq('skipped')
    end
  end

  describe '#stop' do
    before do
      formatter.start(build_start_notification)
    end

    it 'finishes the session span' do
      formatter.stop(build_stop_notification)
      session_span = exporter.finished_spans.find { |s| s.name == 'rspec session start' }
      expect(session_span).not_to be_nil
    end

    it 'prints MERGIFY_TEST_RUN_ID to output' do
      formatter.stop(build_stop_notification)
      expect(output.string).to include('MERGIFY_TEST_RUN_ID=abc123')
    end

    it 'prints Mergify CI header' do
      formatter.stop(build_stop_notification)
      expect(output.string).to include('Mergify CI')
    end

    it 'calls force_flush on tracer_provider' do
      formatter.stop(build_stop_notification)
      expect(ci_insights.tracer_provider).to have_received(:force_flush)
    end

    it 'calls shutdown on tracer_provider' do
      formatter.stop(build_stop_notification)
      expect(ci_insights.tracer_provider).to have_received(:shutdown)
    end

    context 'when there are no errors' do
      it 'sets session span status to OK' do
        formatter.stop(build_stop_notification)
        session_span = exporter.finished_spans.find { |s| s.name == 'rspec session start' }
        expect(session_span.status.code).to eq(OpenTelemetry::Trace::Status::OK)
      end
    end

    context 'when there are errors' do
      it 'sets session span status to ERROR' do
        example = build_example
        notification = build_example_notification(example)
        formatter.example_started(notification)
        allow(example).to receive(:execution_result).and_return(build_failed_execution_result)
        formatter.example_finished(notification)

        formatter.stop(build_stop_notification)
        session_span = exporter.finished_spans.find { |s| s.name == 'rspec session start' }
        expect(session_span.status.code).to eq(OpenTelemetry::Trace::Status::ERROR)
      end
    end

    context 'when token is missing' do
      before do
        allow(ci_insights).to receive(:token).and_return(nil)
      end

      it 'prints a token warning' do
        formatter.stop(build_stop_notification)
        expect(output.string).to include('MERGIFY_TOKEN')
      end
    end

    context 'when repo_name is missing' do
      before do
        allow(ci_insights).to receive(:repo_name).and_return(nil)
      end

      it 'prints a repo warning' do
        formatter.stop(build_stop_notification)
        expect(output.string).to include('repository')
      end
    end
  end
end
