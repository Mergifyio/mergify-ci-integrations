# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/ci_insights'

RSpec.describe Mergify::RSpec do # rubocop:disable RSpec/SpecFilePathFormat
  describe Mergify::RSpec::SynchronousBatchSpanProcessor do
    let(:exporter) { OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new }
    let(:processor) { described_class.new(exporter) }

    def build_span(sampled: true)
      trace_flags = sampled ? OpenTelemetry::Trace::TraceFlags::SAMPLED : OpenTelemetry::Trace::TraceFlags::DEFAULT
      span_context = OpenTelemetry::Trace::SpanContext.new(
        trace_id: Random.bytes(16),
        span_id: Random.bytes(8),
        trace_flags: trace_flags
      )
      span_data = Object.new
      span = Object.new
      span.define_singleton_method(:context) { span_context }
      span.define_singleton_method(:to_span_data) { span_data }
      span
    end

    describe '#on_finish' do
      it 'queues sampled spans as span data' do
        span = build_span(sampled: true)
        processor.on_finish(span)
        expect(processor.instance_variable_get(:@queue)).to contain_exactly(span.to_span_data)
      end

      it 'skips unsampled spans' do
        span = build_span(sampled: false)
        processor.on_finish(span)
        expect(processor.instance_variable_get(:@queue)).to be_empty
      end
    end

    describe '#force_flush' do
      it 'exports all queued spans and clears the queue' do
        span1 = build_span(sampled: true)
        span2 = build_span(sampled: true)
        span_data1 = span1.to_span_data
        span_data2 = span2.to_span_data
        allow(exporter).to receive(:export).with([span_data1, span_data2])
                                           .and_return(OpenTelemetry::SDK::Trace::Export::SUCCESS)

        processor.on_finish(span1)
        processor.on_finish(span2)
        result = processor.force_flush

        expect(result).to eq(OpenTelemetry::SDK::Trace::Export::SUCCESS)
        expect(exporter).to have_received(:export).with([span_data1, span_data2])
        expect(processor.instance_variable_get(:@queue)).to be_empty
      end

      it 'raises ExportError when export fails' do
        span = build_span(sampled: true)
        allow(exporter).to receive(:export).and_return(OpenTelemetry::SDK::Trace::Export::FAILURE)

        processor.on_finish(span)
        expect { processor.force_flush }.to raise_error(Mergify::RSpec::ExportError, /Failed to export traces/)
      end

      it 'clears queue before exporting (so queue is always empty after force_flush attempt)' do
        span = build_span(sampled: true)
        allow(exporter).to receive(:export).and_raise(StandardError, 'network error')

        processor.on_finish(span)
        expect { processor.force_flush }.to raise_error(StandardError, 'network error')
        expect(processor.instance_variable_get(:@queue)).to be_empty
      end
    end
  end

  describe Mergify::RSpec::CIInsights do
    around do |example|
      original = ENV.to_h
      example.run
      ENV.replace(original)
    end

    def clear_ci_env
      %w[CI RSPEC_MERGIFY_ENABLE GITHUB_ACTIONS CIRCLECI JENKINS_URL _RSPEC_MERGIFY_TEST
         MERGIFY_TOKEN MERGIFY_API_URL RSPEC_MERGIFY_DEBUG].each do |var|
        ENV.delete(var)
      end
    end

    describe 'when not in CI' do
      before do
        clear_ci_env
        allow(Mergify::RSpec::Utils).to receive(:in_ci?).and_return(false)
      end

      it 'has a nil tracer' do
        insights = described_class.new
        expect(insights.tracer).to be_nil
      end

      it 'has a nil tracer_provider' do
        insights = described_class.new
        expect(insights.tracer_provider).to be_nil
      end
    end

    describe 'when in CI without token' do
      before do
        clear_ci_env
        allow(Mergify::RSpec::Utils).to receive_messages(in_ci?: true, repository_name: 'owner/repo')
        ENV.delete('MERGIFY_TOKEN')
        ENV.delete('_RSPEC_MERGIFY_TEST')
      end

      it 'has a nil tracer' do
        insights = described_class.new
        expect(insights.tracer).to be_nil
      end
    end

    describe 'when in CI with test mode' do
      before do
        clear_ci_env
        allow(Mergify::RSpec::Utils).to receive_messages(in_ci?: true, repository_name: 'owner/repo')
        ENV['MERGIFY_TOKEN'] = 'test-token'
        ENV['_RSPEC_MERGIFY_TEST'] = 'true'

        # Stub all resource detectors to return empty resources
        empty = OpenTelemetry::SDK::Resources::Resource.create({})
        allow(Mergify::RSpec::Resources::CI).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::Git).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::GitHubActions).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::Jenkins).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::Mergify).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::RSpec).to receive(:detect).and_return(empty)
      end

      it 'creates a tracer' do
        insights = described_class.new
        expect(insights.tracer).not_to be_nil
      end

      it 'generates a valid test_run_id' do
        insights = described_class.new
        expect(insights.test_run_id).to match(/\A[0-9a-f]{16}\z/)
      end

      it 'creates a tracer_provider' do
        insights = described_class.new
        expect(insights.tracer_provider).to be_a(OpenTelemetry::SDK::Trace::TracerProvider)
      end

      it 'uses InMemorySpanExporter' do
        insights = described_class.new
        expect(insights.exporter).to be_a(OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter)
      end

      it 'has nil flaky_detector when flag is not set' do
        insights = described_class.new
        expect(insights.flaky_detector).to be_nil
      end

      it 'has nil quarantined_tests without branch_name' do
        insights = described_class.new
        expect(insights.quarantined_tests).to be_nil
      end

      it 'returns false for mark_test_as_quarantined_if_needed without quarantine' do
        insights = described_class.new
        expect(insights.mark_test_as_quarantined_if_needed('some/example/id')).to be(false)
      end
    end

    describe 'when in CI with flaky detection enabled' do
      before do
        clear_ci_env
        allow(Mergify::RSpec::Utils).to receive_messages(in_ci?: true, repository_name: 'owner/repo')
        allow(Mergify::RSpec::Utils).to receive(:env_truthy?).with('_MERGIFY_TEST_NEW_FLAKY_DETECTION').and_return(true)
        ENV['MERGIFY_TOKEN'] = 'test-token'
        ENV['_RSPEC_MERGIFY_TEST'] = 'true'

        empty = OpenTelemetry::SDK::Resources::Resource.create({})
        allow(Mergify::RSpec::Resources::CI).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::Git).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::GitHubActions).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::Jenkins).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::Mergify).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::RSpec).to receive(:detect).and_return(empty)
      end

      it 'loads flaky_detector when API succeeds' do
        stub_request(:get, 'https://api.mergify.com/v1/ci/owner/repositories/repo/flaky-detection-context')
          .to_return(
            status: 200,
            body: {
              budget_ratio_for_new_tests: 0.1,
              budget_ratio_for_unhealthy_tests: 0.2,
              existing_test_names: ['./spec/old_spec.rb[1:1]'],
              existing_tests_mean_duration_ms: 100,
              unhealthy_test_names: [],
              max_test_execution_count: 10,
              max_test_name_length: 500,
              min_budget_duration_ms: 5000,
              min_test_execution_count: 3
            }.to_json,
            headers: { 'Content-Type' => 'application/json' }
          )

        insights = described_class.new
        expect(insights.flaky_detector).to be_a(Mergify::RSpec::FlakyDetector)
        expect(insights.flaky_detector_error_message).to be_nil
      end

      it 'sets error message when API fails' do
        stub_request(:get, 'https://api.mergify.com/v1/ci/owner/repositories/repo/flaky-detection-context')
          .to_return(status: 500, body: 'Internal Server Error')

        insights = described_class.new
        expect(insights.flaky_detector).to be_nil
        expect(insights.flaky_detector_error_message).to include('Could not load flaky detector')
      end

      it 'sets error message when connection times out' do
        stub_request(:get, 'https://api.mergify.com/v1/ci/owner/repositories/repo/flaky-detection-context')
          .to_timeout

        insights = described_class.new
        expect(insights.flaky_detector).to be_nil
        expect(insights.flaky_detector_error_message).to include('Could not load flaky detector')
      end
    end

    describe 'when in CI with branch_name available' do
      before do
        clear_ci_env
        allow(Mergify::RSpec::Utils).to receive_messages(in_ci?: true, repository_name: 'owner/repo')
        ENV['MERGIFY_TOKEN'] = 'test-token'
        ENV['_RSPEC_MERGIFY_TEST'] = 'true'

        empty = OpenTelemetry::SDK::Resources::Resource.create({})
        branch_resource = OpenTelemetry::SDK::Resources::Resource.create('vcs.ref.head.name' => 'main')
        allow(Mergify::RSpec::Resources::CI).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::Git).to receive(:detect).and_return(branch_resource)
        allow(Mergify::RSpec::Resources::GitHubActions).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::Jenkins).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::Mergify).to receive(:detect).and_return(empty)
        allow(Mergify::RSpec::Resources::RSpec).to receive(:detect).and_return(empty)
      end

      it 'loads quarantined_tests' do
        stub_request(:get, 'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines')
          .with(query: { branch: 'main' })
          .to_return(
            status: 200,
            body: { quarantined_tests: [{ test_name: './spec/foo_spec.rb[1:1]' }] }.to_json,
            headers: { 'Content-Type' => 'application/json' }
          )

        insights = described_class.new
        expect(insights.branch_name).to eq('main')
        expect(insights.quarantined_tests).to be_a(Mergify::RSpec::Quarantine)
        expect(insights.quarantined_tests.include?('./spec/foo_spec.rb[1:1]')).to be true
      end

      it 'returns true for mark_test_as_quarantined_if_needed with quarantined test' do
        stub_request(:get, 'https://api.mergify.com/v1/ci/owner/repositories/repo/quarantines')
          .with(query: { branch: 'main' })
          .to_return(
            status: 200,
            body: { quarantined_tests: [{ test_name: './spec/foo_spec.rb[1:1]' }] }.to_json,
            headers: { 'Content-Type' => 'application/json' }
          )

        insights = described_class.new
        expect(insights.mark_test_as_quarantined_if_needed('./spec/foo_spec.rb[1:1]')).to be true
        expect(insights.mark_test_as_quarantined_if_needed('./spec/bar_spec.rb[1:1]')).to be false
      end
    end
  end
end
