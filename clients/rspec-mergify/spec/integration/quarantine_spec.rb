# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/ci_insights'
require 'mergify/rspec/formatter'
require 'mergify/rspec/quarantine'
require_relative '../support/sandbox_helper'

RSpec.describe 'Integration: Quarantine' do # rubocop:disable RSpec/DescribeClass
  # Quarantine fetches happen in Rust now, past WebMock's reach, so stub the
  # binding's client instead of the HTTP call.
  def stub_quarantine(names)
    client = instance_double(Mergify::RSpec::Native::Client, fetch_quarantine: names)
    allow(Mergify::RSpec::Native).to receive(:available?).and_return(true)
    allow(Mergify::RSpec::Native::Client).to receive(:new).and_return(client)
  end
  include SandboxHelper

  around do |example|
    original_ci_insights = Mergify::RSpec.ci_insights
    original_env = ENV.to_h
    example.run
  ensure
    Mergify::RSpec.ci_insights = original_ci_insights
    ENV.replace(original_env)
  end

  # Helper to get the example span by its code.function attribute
  def find_span_by_function(spans, function_name)
    spans.values.find { |s| s.attributes['code.function'] == function_name }
  end

  # Discovers example IDs by creating a temporary group with the same block,
  # extracting the IDs, then cleaning up. This is needed because the example
  # IDs are generated from the describe hierarchy and must match.
  def discover_example_ids(&block)
    group = RSpec::Core::ExampleGroup.describe('Sandbox', &block)
    ids = group.examples.to_h { |e| [e.description, e.id] }
    RSpec.world.example_groups.delete(group)
    ids
  end

  describe 'quarantined failing test' do
    it 'has skipped status and cicd.test.quarantined=true' do
      # Discover the example ID
      ids = discover_example_ids do
        it('quarantined_fail') { expect(false).to be(true) }
      end

      ci = build_test_ci_insights(quarantined_tests: [ids['quarantined_fail']])
      spans, = run_examples_in_sandbox(ci) do
        it('quarantined_fail') { expect(false).to be(true) }
      end

      span = find_span_by_function(spans, 'quarantined_fail')
      expect(span).not_to be_nil
      # Quarantined failing test is overridden to pending/skipped
      expect(span.attributes['test.case.result.status']).to eq('skipped')
      expect(span.attributes['cicd.test.quarantined']).to be(true)
    end
  end

  describe 'non-quarantined failing test' do
    it 'has ERROR status and cicd.test.quarantined=false' do
      ci = build_test_ci_insights(quarantined_tests: [])
      spans, = run_examples_in_sandbox(ci) do
        it('normal_fail') { expect(false).to be(true) }
      end

      span = find_span_by_function(spans, 'normal_fail')
      expect(span).not_to be_nil
      expect(span.attributes['test.case.result.status']).to eq('failed')
      expect(span.status).to eq('error')
      expect(span.attributes['cicd.test.quarantined']).to be(false)
    end
  end

  describe 'quarantined passing test' do
    it 'has OK status and cicd.test.quarantined=true' do
      ids = discover_example_ids do
        it('quarantined_pass') { expect(true).to be(true) }
      end

      ci = build_test_ci_insights(quarantined_tests: [ids['quarantined_pass']])
      spans, = run_examples_in_sandbox(ci) do
        it('quarantined_pass') { expect(true).to be(true) }
      end

      span = find_span_by_function(spans, 'quarantined_pass')
      expect(span).not_to be_nil
      expect(span.attributes['test.case.result.status']).to eq('passed')
      expect(span.status).to eq('ok')
      expect(span.attributes['cicd.test.quarantined']).to be(true)
    end
  end

  describe 'mixed quarantined and non-quarantined tests' do
    it 'correctly distinguishes quarantined from non-quarantined' do
      ids = discover_example_ids do
        it('not_quarantined_pass') { expect(true).to be(true) }
        it('not_quarantined_fail') { expect(false).to be(true) }
        it('quarantined_fail') { expect(false).to be(true) }
        it('quarantined_pass') { expect(true).to be(true) }
      end

      quarantined_ids = [ids['quarantined_fail'], ids['quarantined_pass']]
      ci = build_test_ci_insights(quarantined_tests: quarantined_ids)
      spans, = run_examples_in_sandbox(ci) do
        it('not_quarantined_pass') { expect(true).to be(true) }
        it('not_quarantined_fail') { expect(false).to be(true) }
        it('quarantined_fail') { expect(false).to be(true) }
        it('quarantined_pass') { expect(true).to be(true) }
      end

      # Non-quarantined passing test
      s = find_span_by_function(spans, 'not_quarantined_pass')
      expect(s.status).to eq('ok')
      expect(s.attributes['cicd.test.quarantined']).to be(false)

      # Non-quarantined failing test
      s = find_span_by_function(spans, 'not_quarantined_fail')
      expect(s.status).to eq('error')
      expect(s.attributes['cicd.test.quarantined']).to be(false)

      # Quarantined failing test (overridden to skipped)
      s = find_span_by_function(spans, 'quarantined_fail')
      expect(s.attributes['test.case.result.status']).to eq('skipped')
      expect(s.attributes['cicd.test.quarantined']).to be(true)

      # Quarantined passing test
      s = find_span_by_function(spans, 'quarantined_pass')
      expect(s.status).to eq('ok')
      expect(s.attributes['cicd.test.quarantined']).to be(true)
    end
  end

  describe 'quarantine API integration' do
    it 'fetches and matches quarantined tests via HTTP' do
      stub_quarantine(['./spec/flaky_spec.rb[1:1]', './spec/flaky_spec.rb[1:2]'])

      q = Mergify::RSpec::Quarantine.new(
        api_url: 'https://api.mergify.com',
        token: 'test-token',
        repo_name: 'owner/repo',
        branch_name: 'main'
      )

      expect(q.include?('./spec/flaky_spec.rb[1:1]')).to be true
      expect(q.include?('./spec/ok_spec.rb[1:1]')).to be false

      q.mark_as_used('./spec/flaky_spec.rb[1:1]')
      report = q.report
      expect(report).to include('owner/repo')
      expect(report).to include('main')
      expect(report).to include('Quarantined')
      expect(report).to include('./spec/flaky_spec.rb[1:1]')
      expect(report).to include('Unused')
      expect(report).to include('./spec/flaky_spec.rb[1:2]')
    end
  end
end
