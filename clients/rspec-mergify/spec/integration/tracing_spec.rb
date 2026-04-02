# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/ci_insights'

RSpec.describe 'Integration: Tracing' do # rubocop:disable RSpec/DescribeClass
  around do |example|
    original_ci_insights = Mergify::RSpec.ci_insights
    original_env = ENV.to_h
    example.run
    Mergify::RSpec.ci_insights = original_ci_insights
    ENV.replace(original_env)
  end

  it 'creates spans for tests in test mode' do
    ENV.delete('CI')
    ENV.delete('RSPEC_MERGIFY_ENABLE')
    ENV['MERGIFY_TOKEN'] = 'test-token'
    ENV['_RSPEC_MERGIFY_TEST'] = 'true'
    ENV.delete('RSPEC_MERGIFY_DEBUG')

    allow(Mergify::RSpec::Utils).to receive_messages(
      in_ci?: true,
      repository_name: 'owner/repo'
    )
    allow(Mergify::RSpec::Utils).to receive(:env_truthy?).with('_MERGIFY_TEST_NEW_FLAKY_DETECTION').and_return(false)

    empty_resource = OpenTelemetry::SDK::Resources::Resource.create({})
    [
      Mergify::RSpec::Resources::CI,
      Mergify::RSpec::Resources::Git,
      Mergify::RSpec::Resources::GitHubActions,
      Mergify::RSpec::Resources::Jenkins,
      Mergify::RSpec::Resources::Mergify,
      Mergify::RSpec::Resources::RSpec
    ].each { |r| allow(r).to receive(:detect).and_return(empty_resource) }

    ci = Mergify::RSpec::CIInsights.new
    Mergify::RSpec.ci_insights = ci

    expect(ci.exporter).to be_a(OpenTelemetry::SDK::Trace::Export::InMemorySpanExporter)
    expect(ci.tracer).not_to be_nil

    span = ci.tracer.start_span('test span', attributes: { 'test.scope' => 'case' })
    span.status = OpenTelemetry::Trace::Status.ok
    span.finish

    ci.tracer_provider.force_flush
    spans = ci.exporter.finished_spans
    expect(spans.length).to eq(1)
    expect(spans.first.name).to eq('test span')
    expect(spans.first.attributes['test.scope']).to eq('case')
  end
end
