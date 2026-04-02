# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/ci_insights'
require 'mergify/rspec/formatter'
require_relative '../support/sandbox_helper'

RSpec.describe 'Integration: Tracing' do # rubocop:disable RSpec/DescribeClass
  include SandboxHelper

  around do |example|
    original_ci_insights = Mergify::RSpec.ci_insights
    original_env = ENV.to_h
    example.run
  ensure
    Mergify::RSpec.ci_insights = original_ci_insights
    ENV.replace(original_env)
  end

  describe 'passing test' do
    it 'creates a span with correct attributes' do
      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('passes') { expect(true).to be(true) }
      end

      example_span = spans.values.find { |s| s.attributes['test.scope'] == 'case' }
      expect(example_span).not_to be_nil
      expect(example_span.attributes['test.scope']).to eq('case')
      expect(example_span.attributes['code.filepath']).to be_a(String)
      expect(example_span.attributes['code.function']).to eq('passes')
      expect(example_span.attributes['code.namespace']).to eq('Sandbox')
      expect(example_span.attributes['code.lineno']).to be_a(Integer)
      expect(example_span.attributes['test.case.result.status']).to eq('passed')
      expect(example_span.attributes['cicd.test.quarantined']).to be(false)
      expect(example_span.status.code).to eq(OpenTelemetry::Trace::Status::OK)
    end
  end

  describe 'session span' do
    it 'is created with test.scope=session' do
      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('passes') { expect(true).to be(true) }
      end

      session_span = spans['rspec session start']
      expect(session_span).not_to be_nil
      expect(session_span.attributes['test.scope']).to eq('session')
    end

    it 'has OK status when all tests pass' do
      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('passes') { expect(true).to be(true) }
      end

      session_span = spans['rspec session start']
      expect(session_span.status.code).to eq(OpenTelemetry::Trace::Status::OK)
    end

    it 'has ERROR status when any test fails' do
      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('fails') { expect(false).to be(true) }
      end

      session_span = spans['rspec session start']
      expect(session_span.status.code).to eq(OpenTelemetry::Trace::Status::ERROR)
    end
  end

  describe 'failing test' do
    it 'sets error status and exception attributes' do
      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('fails') { expect(false).to be(true) }
      end

      example_span = spans.values.find { |s| s.attributes['test.scope'] == 'case' }
      expect(example_span).not_to be_nil
      expect(example_span.attributes['test.case.result.status']).to eq('failed')
      expect(example_span.status.code).to eq(OpenTelemetry::Trace::Status::ERROR)
      expect(example_span.attributes['exception.type']).to be_a(String)
      expect(example_span.attributes['exception.type']).not_to be_empty
      expect(example_span.attributes['exception.message']).to be_a(String)
      expect(example_span.attributes['exception.message']).not_to be_empty
    end
  end

  describe 'pending test' do
    it 'has skipped status' do
      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('is pending') {
          pending('not yet')
          expect(false).to be(true)
        }
      end

      example_span = spans.values.find { |s| s.attributes['test.scope'] == 'case' }
      expect(example_span).not_to be_nil
      expect(example_span.attributes['test.case.result.status']).to eq('skipped')
    end
  end

  describe 'parent-child span relationship' do
    it 'test spans are children of session span' do
      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('passes') { expect(true).to be(true) }
      end

      session_span = spans['rspec session start']
      example_span = spans.values.find { |s| s.attributes['test.scope'] == 'case' }

      expect(example_span.parent_span_id).to eq(session_span.span_id)
    end
  end

  describe 'test.run.id resource attribute' do
    it 'is present and a valid hex string on all spans' do
      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('passes') { expect(true).to be(true) }
      end

      spans.each_value do |span|
        test_run_id = span.resource.attribute_enumerator.to_h['test.run.id']
        expect(test_run_id).to be_a(String)
        expect(test_run_id.length).to eq(16)
        expect { Integer(test_run_id, 16) }.not_to raise_error
      end
    end
  end

  describe 'multiple tests' do
    it 'creates a span for each test plus the session' do
      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('first passes') { expect(true).to be(true) }
        it('second passes') { expect(1 + 1).to eq(2) }
      end

      case_spans = spans.values.select { |s| s.attributes['test.scope'] == 'case' }
      expect(case_spans.size).to eq(2)
      expect(spans).to have_key('rspec session start')
    end
  end

  describe 'terminal output' do
    it 'includes MERGIFY_TEST_RUN_ID' do
      ci = build_test_ci_insights
      _, output = run_examples_in_sandbox(ci) do
        it('passes') { expect(true).to be(true) }
      end

      expect(output).to include("MERGIFY_TEST_RUN_ID=#{ci.test_run_id}")
    end

    it 'includes Mergify CI header' do
      ci = build_test_ci_insights
      _, output = run_examples_in_sandbox(ci) do
        it('passes') { expect(true).to be(true) }
      end

      expect(output).to include('Mergify CI')
    end
  end

  describe 'distributed tracing' do
    it 'sets parent context from MERGIFY_TRACEPARENT' do
      ENV['MERGIFY_TRACEPARENT'] = '00-80e1afed08e019fc1110464cfa66635c-7a085853722dc6d2-01'

      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('passes') { expect(true).to be(true) }
      end

      session_span = spans['rspec session start']
      expect(session_span).not_to be_nil
      # The session span should have the trace ID from traceparent
      trace_id_hex = session_span.hex_trace_id
      expect(trace_id_hex).to eq('80e1afed08e019fc1110464cfa66635c')
    end
  end

  describe 'when not in CI' do
    it 'does not create a tracer or any spans' do
      allow(Mergify::RSpec::Utils).to receive(:in_ci?).and_return(false)
      ENV.delete('MERGIFY_TOKEN')
      ENV.delete('_RSPEC_MERGIFY_TEST')

      ci = Mergify::RSpec::CIInsights.new
      expect(ci.tracer).to be_nil
      expect(ci.tracer_provider).to be_nil
      expect(ci.exporter).to be_nil
    end
  end

  describe 'when token is missing' do
    it 'prints a warning about missing token' do
      ENV.delete('MERGIFY_TOKEN')
      ENV['_RSPEC_MERGIFY_TEST'] = 'true'
      allow(Mergify::RSpec::Utils).to receive_messages(in_ci?: true, repository_name: 'owner/repo')

      ci = Mergify::RSpec::CIInsights.new
      # No token means no tracer in test mode... actually in test mode the exporter
      # is created regardless. Let me check the logic.
      # build_in_memory_processor is called when debug_mode? or test_mode?, regardless of token.
      # So we need to test the warning path differently.

      # The warning is printed by the formatter when ci_insights.token is nil.
      # Let's create a ci_insights with nil token:
      ci.instance_variable_set(:@token, nil)

      Mergify::RSpec.ci_insights = ci
      output = StringIO.new
      formatter = Mergify::RSpec::Formatter.new(output)

      group = RSpec::Core::ExampleGroup.describe('NoToken') do
        it('passes') { expect(true).to be(true) }
      end

      begin
        formatter.start(RSpec::Core::Notifications::StartNotification.new(1))
        ex = group.examples.first
        formatter.example_started(RSpec::Core::Notifications::ExampleNotification.for(ex))
        group_instance = group.new
        ex.instance_variable_set(:@example_group_instance, group_instance)
        reporter = double('reporter')
        allow(reporter).to receive_messages(notify: nil, example_started: nil, example_finished: nil,
                                            example_failed: nil, example_passed: nil, example_pending: nil,
                                            deprecation: nil)
        ex.run(group_instance, reporter)
        formatter.example_finished(RSpec::Core::Notifications::ExampleNotification.for(ex))
        allow(ci.tracer_provider).to receive(:force_flush) if ci.tracer_provider
        allow(ci.tracer_provider).to receive(:shutdown) if ci.tracer_provider
        formatter.stop(double('stop'))
      ensure
        RSpec.world.example_groups.delete(group)
      end

      expect(output.string).to include('MERGIFY_TOKEN is not set')
    end
  end

  describe 'when repo name is missing' do
    it 'prints a warning about missing repository name' do
      ENV['MERGIFY_TOKEN'] = 'test-token'
      ENV['_RSPEC_MERGIFY_TEST'] = 'true'
      allow(Mergify::RSpec::Utils).to receive_messages(in_ci?: true, repository_name: nil)

      empty_resource = OpenTelemetry::SDK::Resources::Resource.create({})
      [
        Mergify::RSpec::Resources::CI, Mergify::RSpec::Resources::Git,
        Mergify::RSpec::Resources::GitHubActions, Mergify::RSpec::Resources::Jenkins,
        Mergify::RSpec::Resources::Mergify, Mergify::RSpec::Resources::RSpec
      ].each { |r| allow(r).to receive(:detect).and_return(empty_resource) }

      ci = Mergify::RSpec::CIInsights.new
      ci.instance_variable_set(:@repo_name, nil)

      Mergify::RSpec.ci_insights = ci
      output = StringIO.new
      formatter = Mergify::RSpec::Formatter.new(output)

      group = RSpec::Core::ExampleGroup.describe('NoRepo') do
        it('passes') { expect(true).to be(true) }
      end

      begin
        formatter.start(RSpec::Core::Notifications::StartNotification.new(1))
        ex = group.examples.first
        formatter.example_started(RSpec::Core::Notifications::ExampleNotification.for(ex))
        group_instance = group.new
        ex.instance_variable_set(:@example_group_instance, group_instance)
        reporter = double('reporter')
        allow(reporter).to receive_messages(notify: nil, example_started: nil, example_finished: nil,
                                            example_failed: nil, example_passed: nil, example_pending: nil,
                                            deprecation: nil)
        ex.run(group_instance, reporter)
        formatter.example_finished(RSpec::Core::Notifications::ExampleNotification.for(ex))
        allow(ci.tracer_provider).to receive(:force_flush) if ci.tracer_provider
        allow(ci.tracer_provider).to receive(:shutdown) if ci.tracer_provider
        formatter.stop(double('stop'))
      ensure
        RSpec.world.example_groups.delete(group)
      end

      expect(output.string).to include('Could not detect repository name')
    end
  end
end
