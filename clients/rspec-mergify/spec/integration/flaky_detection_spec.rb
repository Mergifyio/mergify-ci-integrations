# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/ci_insights'
require 'mergify/rspec/formatter'
require_relative '../support/sandbox_helper'

RSpec.describe 'Integration: Flaky Detection' do # rubocop:disable RSpec/DescribeClass
  include SandboxHelper

  around do |example|
    original_ci_insights = Mergify::RSpec.ci_insights
    original_env = ENV.to_h
    example.run
  ensure
    Mergify::RSpec.ci_insights = original_ci_insights
    ENV.replace(original_env)
  end

  def find_span_by_function(spans, function_name)
    spans.values.find { |s| s.attributes['code.function'] == function_name }
  end

  # Helper to run an example with manually-injected flaky metadata.
  # This simulates what the around(:each) hook in Configuration does.
  def run_with_flaky_metadata(insights, metadata_overrides = {})
    Mergify::RSpec.ci_insights = insights

    output = StringIO.new
    formatter = Mergify::RSpec::Formatter.new(output)

    group = RSpec::Core::ExampleGroup.describe('FlakyTest') do
      it('the_test') { expect(true).to be(true) }
    end

    begin
      start_notification = RSpec::Core::Notifications::StartNotification.new(1)
      formatter.start(start_notification)

      ex = group.examples.first
      formatter.example_started(RSpec::Core::Notifications::ExampleNotification.for(ex))

      group_instance = group.new
      ex.instance_variable_set(:@example_group_instance, group_instance)
      reporter = double('reporter')
      allow(reporter).to receive_messages(notify: nil, example_started: nil, example_finished: nil,
                                          example_failed: nil, example_passed: nil, example_pending: nil,
                                          deprecation: nil)
      ex.run(group_instance, reporter)

      # Inject flaky metadata as the around hook would
      metadata_overrides.each { |k, v| ex.metadata[k] = v }

      formatter.example_finished(RSpec::Core::Notifications::ExampleNotification.for(ex))

      stop_notification = double('stop_notification')
      formatter.stop(stop_notification)

      spans = insights.exporter.finished_spans.to_h { |s| [s.name, s] }
      span = spans.values.find { |s| s.attributes['test.scope'] == 'case' }

      [span, output.string]
    ensure
      RSpec.world.example_groups.delete(group)
    end
  end

  describe 'flaky metadata on spans' do
    it 'sets cicd.test.flaky when metadata is present' do
      ci = build_test_ci_insights
      span, = run_with_flaky_metadata(ci,
                                      mergify_flaky: true,
                                      mergify_flaky_detection: true,
                                      mergify_rerun_count: 3,
                                      mergify_new_test: true)

      expect(span).not_to be_nil
      expect(span.attributes['cicd.test.flaky']).to be(true)
      expect(span.attributes['cicd.test.flaky_detection']).to be(true)
      expect(span.attributes['cicd.test.rerun_count']).to eq(3)
      expect(span.attributes['cicd.test.new']).to be(true)
    end

    it 'does not set flaky attributes when metadata is absent' do
      ci = build_test_ci_insights
      spans, = run_examples_in_sandbox(ci) do
        it('normal_test') { expect(true).to be(true) }
      end

      span = find_span_by_function(spans, 'normal_test')
      expect(span).not_to be_nil
      expect(span.attributes).not_to have_key('cicd.test.flaky')
      expect(span.attributes).not_to have_key('cicd.test.flaky_detection')
      expect(span.attributes).not_to have_key('cicd.test.rerun_count')
      expect(span.attributes).not_to have_key('cicd.test.new')
    end
  end

  describe 'flaky detection with rerun_count=0' do
    it 'sets rerun_count when metadata is zero' do
      ci = build_test_ci_insights
      span, = run_with_flaky_metadata(ci,
                                      mergify_rerun_count: 0,
                                      mergify_flaky_detection: true)

      expect(span.attributes['cicd.test.rerun_count']).to eq(0)
      expect(span.attributes['cicd.test.flaky_detection']).to be(true)
      expect(span.attributes).not_to have_key('cicd.test.flaky')
    end
  end

  describe 'flaky but not new test' do
    it 'sets flaky without new_test attribute' do
      ci = build_test_ci_insights
      span, = run_with_flaky_metadata(ci,
                                      mergify_flaky: true,
                                      mergify_flaky_detection: true,
                                      mergify_rerun_count: 2)

      expect(span.attributes['cicd.test.flaky']).to be(true)
      expect(span.attributes['cicd.test.rerun_count']).to eq(2)
      expect(span.attributes).not_to have_key('cicd.test.new')
    end
  end
end
