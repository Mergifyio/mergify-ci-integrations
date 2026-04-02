# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/ci_insights'

RSpec.describe Mergify::RSpec::SynchronousBatchSpanProcessor do
  let(:exporter) { OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter.new }
  let(:processor) { described_class.new(exporter) }

  def build_span(sampled: true)
    trace_flags = sampled ? OpenTelemetry::Trace::TraceFlags::SAMPLED : OpenTelemetry::Trace::TraceFlags::DEFAULT
    span_context = OpenTelemetry::Trace::SpanContext.new(
      trace_id: Random.bytes(16),
      span_id: Random.bytes(8),
      trace_flags: trace_flags
    )
    double('span', context: span_context, to_span_data: double('span_data'))
  end

  describe '#on_finish' do
    it 'queues sampled spans' do
      span = build_span(sampled: true)
      processor.on_finish(span)
      expect(processor.instance_variable_get(:@queue)).to contain_exactly(span)
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
      allow(exporter).to receive(:export).with([span1, span2]).and_return(OpenTelemetry::SDK::Trace::Export::SUCCESS)

      processor.on_finish(span1)
      processor.on_finish(span2)
      result = processor.force_flush

      expect(result).to eq(OpenTelemetry::SDK::Trace::Export::SUCCESS)
      expect(exporter).to have_received(:export).with([span1, span2])
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

RSpec.describe Mergify::RSpec::CIInsights do
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
      allow(Mergify::RSpec::Utils).to receive(:in_ci?).and_return(true)
      allow(Mergify::RSpec::Utils).to receive(:repository_name).and_return('owner/repo')
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
      allow(Mergify::RSpec::Utils).to receive(:in_ci?).and_return(true)
      allow(Mergify::RSpec::Utils).to receive(:repository_name).and_return('owner/repo')
      ENV['MERGIFY_TOKEN'] = 'test-token'
      ENV['_RSPEC_MERGIFY_TEST'] = 'true'

      # Stub all resource detectors to return empty resources
      allow(Mergify::RSpec::Resources::CI).to receive(:detect)
        .and_return(OpenTelemetry::SDK::Resources::Resource.create({}))
      allow(Mergify::RSpec::Resources::Git).to receive(:detect)
        .and_return(OpenTelemetry::SDK::Resources::Resource.create({}))
      allow(Mergify::RSpec::Resources::GitHubActions).to receive(:detect)
        .and_return(OpenTelemetry::SDK::Resources::Resource.create({}))
      allow(Mergify::RSpec::Resources::Jenkins).to receive(:detect)
        .and_return(OpenTelemetry::SDK::Resources::Resource.create({}))
      allow(Mergify::RSpec::Resources::Mergify).to receive(:detect)
        .and_return(OpenTelemetry::SDK::Resources::Resource.create({}))
      allow(Mergify::RSpec::Resources::RSpec).to receive(:detect)
        .and_return(OpenTelemetry::SDK::Resources::Resource.create({}))
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

    it 'has nil flaky_detector' do
      insights = described_class.new
      expect(insights.flaky_detector).to be_nil
    end

    it 'has nil quarantined_tests' do
      insights = described_class.new
      expect(insights.quarantined_tests).to be_nil
    end

    it 'returns false for mark_test_as_quarantined_if_needed' do
      insights = described_class.new
      expect(insights.mark_test_as_quarantined_if_needed('some/example/id')).to be(false)
    end
  end
end
