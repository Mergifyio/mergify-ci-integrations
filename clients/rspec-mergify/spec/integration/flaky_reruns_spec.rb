# frozen_string_literal: true

require 'spec_helper'
require 'json'
require 'open3'
require 'tmpdir'

# The reruns happen in an `around` hook, before RSpec has recorded anything
# about the example, so they can only be checked from a real run: a sandboxed
# example driven by hand skips the very hook under test.
RSpec.describe 'Integration: Flaky detection reruns' do # rubocop:disable RSpec/DescribeClass
  # A pull request's base branch, which puts flaky detection in 'new' mode.
  let(:base_ref) { nil }

  # Passes on its first attempt and fails on every one after.
  let(:probe) do
    <<~RUBY
      RSpec.describe('probe') do
        it('flips') do
          sleep 0.02
          $attempts = ($attempts || 0) + 1
          expect($attempts).to eq(1)
        end
      end
    RUBY
  end

  def context_body(existing:, unhealthy:, quarantined: [])
    {
      quarantined_tests: quarantined.map { |name| { test_name: name } },
      budget_ratio_for_new_tests: 0.1, budget_ratio_for_unhealthy_tests: 0.5,
      existing_test_names: existing, existing_tests_mean_duration_ms: 20,
      unhealthy_test_names: unhealthy,
      max_test_execution_count: 4, max_test_name_length: 1000,
      min_budget_duration_ms: 10_000, min_test_execution_count: 1
    }.to_json
  end

  # Every request gets the same body, which carries the quarantine list and
  # the flaky detection context side by side: each reader ignores the other's
  # fields.
  def run_probe(body, probe: self.probe)
    with_stub_api(status: 200, body: body) do |url, _paths, bodies|
      Dir.mktmpdir do |dir|
        File.write(File.join(dir, 'probe_spec.rb'), probe)
        env = {
          'CI' => 'true', 'MERGIFY_TOKEN' => 'token', 'MERGIFY_API_URL' => url,
          'GITHUB_ACTIONS' => 'true', 'GITHUB_REPOSITORY' => 'owner/repo', 'GITHUB_REF_NAME' => 'main',
          'GITHUB_BASE_REF' => base_ref, 'GITHUB_EVENT_PATH' => nil,
          '_RSPEC_MERGIFY_TEST' => nil, 'RSPEC_MERGIFY_DEBUG' => nil
        }
        command = [RbConfig.ruby, '-I', File.expand_path('../../lib', __dir__),
                   Gem.bin_path('rspec-core', 'rspec'), '--require', 'rspec_mergify', 'probe_spec.rb']
        output = Open3.capture2e(env, *command, chdir: dir).first
        return [output, bodies.join.b]
      end
    end
  end

  context 'when the test is unhealthy' do
    let(:body) { context_body(existing: ['./probe_spec.rb[1:1]'], unhealthy: ['./probe_spec.rb[1:1]']) }

    it 'times every attempt and reruns up to the execution cap' do
      output, = run_probe(body)

      expect(output).to include('Reruns       : 4')
      expect(output).not_to include('Initial dur  : 0.000s')
    end

    it 'reports the test as flaky when its attempts disagree' do
      _, uploaded = run_probe(body)

      # Protobuf prefixes the key with its length, which is what tells it apart
      # from `cicd.test.flaky_detection`.
      expect(uploaded).to include("\x0Fcicd.test.flaky".b)
    end

    it 'keeps the outcome of the first attempt' do
      output, = run_probe(body)

      expect(output).to include('1 example, 0 failures')
    end
  end

  context 'when the test is new' do
    let(:body) { context_body(existing: ['./other_spec.rb[1:1]'], unhealthy: []) }
    let(:base_ref) { 'main' }

    it 'fails the test when any attempt failed' do
      output, = run_probe(body)

      expect(output).to include('1 example, 1 failure')
      expect(output).not_to match(/Got \d+ failures/)
    end
  end

  context 'when the unhealthy test is quarantined' do
    let(:body) do
      context_body(existing: ['./probe_spec.rb[1:1]'], unhealthy: ['./probe_spec.rb[1:1]'],
                   quarantined: ['./probe_spec.rb[1:1]'])
    end

    # Fails on its first attempt and passes on every one after.
    let(:failing_first) { probe.sub('expect($attempts).to eq(1)', 'expect($attempts).not_to eq(1)') }

    it 'stays quarantined and is still found flaky' do
      output, uploaded = run_probe(body, probe: failing_first)

      expect(output).to include('1 example, 0 failures, 1 pending')
      expect(uploaded).to include("\x0Fcicd.test.flaky".b)
    end
  end
end
