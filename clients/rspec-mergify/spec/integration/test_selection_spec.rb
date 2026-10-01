# frozen_string_literal: true

require 'spec_helper'
require 'json'
require 'open3'
require 'tmpdir'
require 'uri'

# Selection happens in a `before(:suite)` hook, over what RSpec itself loaded
# and filtered, so it is only checked from a real run: a real `rspec` process,
# the real binding, and a real HTTP server standing in for Mergify.
RSpec.describe 'Integration: Test selection', if: Mergify::RSpec::Native.available? do # rubocop:disable RSpec/DescribeClass
  let(:spec_files) do
    {
      'a_spec.rb' => <<~RUBY,
        RSpec.describe('a') do
          before(:context) { File.write('a_context_ran', '') }
          it('passes') { expect(1).to eq(1) }
          it('fails') { expect(1).to eq(2) }
        end
      RUBY
      'b_spec.rb' => <<~RUBY
        RSpec.describe('b') do
          it('is slow', :slow) { expect(1).to eq(1) }
          it('also passes') { expect(1).to eq(1) }
        end
      RUBY
    }
  end

  let(:all_ids) { %w[./a_spec.rb[1:1] ./a_spec.rb[1:2] ./b_spec.rb[1:1] ./b_spec.rb[1:2]] }

  # rubocop:disable-next Metrics/ParameterLists,Metrics/CyclomaticComplexity,Metrics/PerceivedComplexity
  def run_suite(answer: nil, selection_status: 200, verdict_status: 200, opt_in: true, rspec_options: [],
                routes: {}, with_token: true)
    routes = {
      'test-selection' => [selection_status, (answer || {}).to_json],
      'test-session-verdicts' => [verdict_status, '{}']
    }.merge(routes)
    with_stub_api(status: 200, body: '{}', routes: routes) do |url, paths, bodies|
      Dir.mktmpdir do |dir|
        spec_files.each { |name, source| File.write(File.join(dir, name), source) }
        # The run's own options go through `.rspec`, the file RSpec reads them
        # from anyway, so the command line below stays the same literal for
        # every example.
        options = rspec_options.any? { |option| option.start_with?('--pattern') } ? [] : ['--pattern *_spec.rb']
        File.write(File.join(dir, '.rspec'), ['--default-path .', *options, *rspec_options].join("\n"))
        run_env = {
          'CI' => 'true', 'MERGIFY_TOKEN' => with_token ? 'token' : '', 'MERGIFY_API_URL' => url,
          'MERGIFY_TEST_SELECTION_ENABLE' => opt_in ? 'true' : nil, 'MERGIFY_TEST_JOB_NAME' => nil,
          'GITHUB_ACTIONS' => 'true', 'GITHUB_REPOSITORY' => 'owner/repo',
          'GITHUB_REF_NAME' => 'mergify/merge-queue/0123', 'GITHUB_HEAD_REF' => nil, 'GITHUB_BASE_REF' => nil,
          'GITHUB_SHA' => 'cafe0123', 'GITHUB_WORKFLOW' => 'CI', 'GITHUB_JOB' => 'rspec',
          'GITHUB_RUN_ID' => '42', 'GITHUB_RUN_ATTEMPT' => '2',
          'GITHUB_EVENT_NAME' => 'push', 'GITHUB_EVENT_PATH' => nil,
          '_RSPEC_MERGIFY_TEST' => nil, 'RSPEC_MERGIFY_DEBUG' => nil, 'TEST_ENV_NUMBER' => nil
        }
        command = [RbConfig.ruby, '-I', File.expand_path('../../lib', __dir__),
                   Gem.bin_path('rspec-core', 'rspec'), '--require', 'rspec_mergify', '--no-color']
        output, status = Open3.capture2e(run_env, *command, chdir: dir)
        output.force_encoding(Encoding::UTF_8)
        verdict_index = paths.index { |path| path.include?('test-session-verdicts') }
        selection_path = paths.find { |path| path.include?('test-selection') }
        return {
          output: output, status: status.exitstatus, paths: paths, uploaded: bodies.join.b,
          selection_query: selection_path && URI.decode_www_form(URI(selection_path).query).to_h,
          verdict: verdict_index && JSON.parse(bodies[verdict_index]),
          context_ran: File.exist?(File.join(dir, 'a_context_ran'))
        }
      end
    end
  end

  def fingerprint(ids)
    Mergify::RSpec::Native.test_collection_fingerprint(ids)
  end

  describe 'asking' do
    it 'asks nothing, and sends no verdict, when the job did not opt in' do
      run = run_suite(opt_in: false)

      expect(run[:paths]).not_to include(a_string_including('test-selection'))
      expect(run[:verdict]).to be_nil
      expect(run[:output]).to include('4 examples, 1 failure')
      expect(run[:output]).not_to include('Test selection')
    end

    it 'still reports the fingerprint of what it collected when the job did not opt in' do
      run = run_suite(opt_in: false)

      expect(run[:uploaded]).to include('test.collection.fingerprint', fingerprint(all_ids))
    end

    it "asks with the run's own identity and the fingerprint of every example it collected" do
      run = run_suite(answer: { selection: 'full', reason: 'no_predecessor' })

      expect(run[:selection_query]).to eq(
        'branch' => 'mergify/merge-queue/0123', 'head_sha' => 'cafe0123',
        'pipeline_name' => 'CI', 'job_name' => 'rspec', 'collection_fingerprint' => fingerprint(all_ids)
      )
    end

    it "fingerprints what RSpec's filters left, not every example it loaded" do
      run = run_suite(answer: { selection: 'full', reason: 'no_predecessor' }, rspec_options: ['--tag ~slow'])

      expected = %w[./a_spec.rb[1:1] ./a_spec.rb[1:2] ./b_spec.rb[1:2]]
      expect(run[:selection_query]['collection_fingerprint']).to eq(fingerprint(expected))
      expect(run[:verdict]['collection_count']).to eq(3)
    end

    it 'asks nothing, and sends no verdict, when there is nothing to run' do
      # Every parallel worker a filter leaves empty would claim the same
      # empty-set fingerprint under the same job.
      run = run_suite(answer: { selection: 'full', reason: 'no_predecessor' }, rspec_options: ['--tag nothing'])

      expect(run[:output]).to include('0 examples, 0 failures')
      expect(run[:paths]).not_to include(a_string_including('test-selection'))
      expect(run[:verdict]).to be_nil
    end

    it 'asks nothing when the token is empty, as a fork or bot pull request gets it' do
      run = run_suite(answer: { selection: 'empty', reason: 'queue_rerun' }, with_token: false)

      expect(run[:paths]).not_to include(a_string_including('test-selection'))
      expect(run[:output]).to include('4 examples, 1 failure')
    end

    it 'fingerprints only the files this process was handed, as a splitter hands them' do
      run = run_suite(answer: { selection: 'full', reason: 'no_predecessor' }, rspec_options: ['--pattern b_spec.rb'])

      expect(run[:selection_query]['collection_fingerprint'])
        .to eq(fingerprint(%w[./b_spec.rb[1:1] ./b_spec.rb[1:2]]))
    end
  end

  describe 'a subset' do
    it 'runs exactly the served examples and skips the rest' do
      run = run_suite(answer: { selection: 'subset', reason: 'queue_rerun', tests: ['./a_spec.rb[1:2]'] })

      expect(run[:output]).to include('1 example, 1 failure')
      expect(run[:status]).to eq(1)
      expect(run[:output]).to include(
        "✂️ Test selection\n\nThe code under test hasn't changed since the previous attempt of this job, where"
      ).and include("  ./a_spec.rb[1:2]\n")
      expect(run[:output].gsub("\n", ' '))
        .to include('Mergify re-executed only that one and skipped the 3 that had already passed:')
    end

    it 'declines the whole answer when one served example was not collected' do
      run = run_suite(answer: { selection: 'subset', reason: 'queue_rerun',
                                tests: ['./a_spec.rb[1:2]', './gone_spec.rb[1:1]'] })

      expect(run[:output]).to include('4 examples, 1 failure')
      expect(run[:output].gsub("\n", ' '))
        .to include("Mergify's answer didn't match the tests this run collected, so the full suite ran.")
      expect(run[:verdict]['selection']).to eq(
        'answer' => 'subset', 'reason' => 'queue_rerun', 'kept_count' => 4,
        'not_applied_reason' => 'subset_partly_absent_from_collection'
      )
    end

    it 'runs everything when not one served example was collected' do
      run = run_suite(answer: { selection: 'subset', reason: 'queue_rerun', tests: ['./gone_spec.rb[1:1]'] })

      expect(run[:output]).to include('4 examples, 1 failure')
      expect(run[:verdict]['selection']['not_applied_reason']).to eq('subset_matched_no_collected_test')
    end
  end

  describe 'an empty answer' do
    it 'runs nothing, sets nothing up, and exits green' do
      run = run_suite(answer: { selection: 'empty', reason: 'queue_rerun' })

      expect(run[:output]).to include('0 examples, 0 failures')
      expect(run[:status]).to eq(0)
      expect(run[:context_ran]).to be(false)
      expect(run[:output].gsub("\n", ' ')).to include(
        'and all 4 tests passed back then. Mergify skipped them: the job is green, and no test was executed.'
      )
    end
  end

  describe 'a refusal' do
    let(:message) { "Mergify Test Selection stopped this run.\n\nThe server's own words." }

    it "fails before any example runs, showing the server's explanation" do
      run = run_suite(answer: { selection: 'refused', reason: 'ambiguous_test_sessions', message: message })

      expect(run[:status]).not_to eq(0)
      expect(run[:output]).to include("The server's own words.")
      expect(run[:output]).not_to include('Failure/Error')
      expect(run[:output]).to include('0 examples, 0 failures, 1 error occurred outside of examples')
      expect(run[:output].gsub("\n", ' '))
        .to include('Mergify stopped this run before any test ran; its explanation is in the error above.')
    end

    it 'falls back to its own explanation when the server sent none' do
      run = run_suite(answer: { selection: 'refused', reason: 'ambiguous_test_sessions' })

      expect(run[:output]).to include('give each run its own name with MERGIFY_TEST_JOB_NAME')
    end

    it 'still tells Mergify what it was answered' do
      run = run_suite(answer: { selection: 'refused', reason: 'ambiguous_test_sessions', message: message })

      expect(run[:verdict]).to include('executed_count' => 0)
      expect(run[:verdict]['selection'])
        .to eq('answer' => 'refused', 'reason' => 'ambiguous_test_sessions', 'kept_count' => 0)
    end
  end

  describe 'a full run' do
    it 'runs everything and says why' do
      run = run_suite(answer: { selection: 'full', reason: 'no_predecessor' })

      expect(run[:output]).to include('4 examples, 1 failure')
      expect(run[:output]).to include('First attempt of this batch, so the full suite ran.')
    end

    it 'runs everything when the request fails, and says so with the error' do
      run = run_suite(selection_status: 500)

      expect(run[:output]).to include('4 examples, 1 failure')
      expect(run[:output].gsub("\n", ' '))
        .to include("Mergify couldn't be asked whether this run could be reduced, so the full suite ran.")
      expect(run[:output]).to match(/^Error: .*500/)
      # Mergify answered nothing, so the verdict echoes no answer.
      expect(run[:verdict]).to include('executed_count' => 4)
      expect(run[:verdict]).not_to have_key('selection')
    end

    it 'runs everything on an answer this gem predates' do
      run = run_suite(answer: { selection: 'sideways', reason: 'whatever' })

      expect(run[:output]).to include('4 examples, 1 failure')
      expect(run[:verdict]['selection']['not_applied_reason']).to eq('unrecognised_selection')
    end
  end

  describe 'the session verdict' do
    it 'names the failing examples by their final status, keyed as the selection was asked' do
      run = run_suite(answer: { selection: 'full', reason: 'no_predecessor' })

      expect(run[:verdict]).to include(
        'head_sha' => 'cafe0123', 'head_branch' => 'mergify/merge-queue/0123',
        'pipeline_name' => 'CI', 'job_name' => 'rspec', 'run_id' => '42', 'run_attempt' => 2,
        'collection_fingerprint' => fingerprint(all_ids), 'collection_count' => 4,
        'executed_count' => 4, 'passed_count' => 3, 'failed_count' => 1, 'skipped_count' => 0,
        'failing_tests' => ['./a_spec.rb[1:2]'], 'quarantined_failing_tests' => [],
        'selection' => { 'answer' => 'full', 'reason' => 'no_predecessor', 'kept_count' => 4 }
      )
      expect(run[:output]).to include("MERGIFY_TEST_RUN_ID=#{run[:verdict]['test_run_id']}")
    end

    it 'is sent before the trace upload' do
      run = run_suite(answer: { selection: 'full', reason: 'no_predecessor' })

      verdict = run[:paths].index { |path| path.include?('test-session-verdicts') }
      traces = run[:paths].index { |path| path.include?('/traces') }
      expect(verdict).to be < traces
    end

    it 'counts only what the selection left to run' do
      run = run_suite(answer: { selection: 'subset', reason: 'queue_rerun', tests: ['./a_spec.rb[1:2]'] })

      expect(run[:verdict]).to include('collection_count' => 4, 'executed_count' => 1, 'failed_count' => 1,
                                       'failing_tests' => ['./a_spec.rb[1:2]'])
      expect(run[:verdict]['selection']).to eq('answer' => 'subset', 'reason' => 'queue_rerun', 'kept_count' => 1)
    end

    it 'lists a failure the quarantine absorbed apart from the ones that gate the job' do
      quarantine = { quarantined_tests: [{ test_name: './a_spec.rb[1:2]' }] }.to_json
      run = run_suite(answer: { selection: 'full', reason: 'no_predecessor' },
                      routes: { 'quarantines' => [200, quarantine] })

      expect(run[:status]).to eq(0)
      expect(run[:verdict]).to include('failing_tests' => [], 'quarantined_failing_tests' => ['./a_spec.rb[1:2]'],
                                       'failed_count' => 1, 'skipped_count' => 0)
    end

    it 'is withheld when the run failed outside any example' do
      spec_files['c_spec.rb'] = <<~RUBY
        RSpec.describe('c') do
          after(:context) { raise 'teardown broke' }
          it('passes') { expect(1).to eq(1) }
        end
      RUBY
      run = run_suite(answer: { selection: 'full', reason: 'no_predecessor' })

      expect(run[:output]).to include('1 error occurred outside of examples')
      expect(run[:paths]).not_to include(a_string_including('test-session-verdicts'))
      expect(run[:output].gsub("\n", ' ')).to include(
        "Mergify wasn't sent this run's results: it failed outside any example. If this merge-queue batch is " \
        'retried, this job will run its full test suite.'
      )
    end

    it 'reports a verdict Mergify did not accept without failing the run' do
      run = run_suite(answer: { selection: 'empty', reason: 'queue_rerun' }, verdict_status: 400)

      expect(run[:status]).to eq(0)
      expect(run[:output].gsub("\n", ' ')).to include("Mergify couldn't record this run's results.")
    end
  end
end
