# frozen_string_literal: true

require 'spec_helper'
require 'mergify/rspec/native'

RSpec.describe Mergify::RSpec::Native do
  around do |example|
    original = ENV.to_h
    example.run
  ensure
    ENV.replace(original)
  end

  describe 'loading' do
    it 'reports its status instead of raising when the extension is absent' do
      expect(described_class).to respond_to(:available?)
      expect(described_class).to respond_to(:load_error)
    end

    it 'records a LoadError, or nothing at all' do
      expect(described_class.load_error).to be_nil.or be_a(LoadError)
      expect(described_class.available?).to be(described_class.load_error.nil?)
    end
  end

  # `rake compile` builds the extension; a bare `bundle exec rspec` on a
  # checkout without it still runs the rest of the suite, so skip rather than
  # fail -- the CI job compiles first, and that is where this is a real gate.
  describe 'detection', if: described_class.available? do
    before { %w[GITHUB_ACTIONS CIRCLECI JENKINS_URL BUILDKITE _RSPEC_MERGIFY_TEST].each { |v| ENV.delete(v) } }

    it "identifies the gem's own suite" do
      ENV['_RSPEC_MERGIFY_TEST'] = 'true'

      expect(described_class.detect_provider).to eq('rspec_mergify_suite')
      expect(described_class.detect_repository_name).to eq('Mergifyio/rspec-mergify')
    end

    # These were the parity gate against the Ruby detectors while both existed.
    # The detectors are gone, so the expectations are now stated outright --
    # same cases, same answers, no second implementation to compare against.
    it 'detects each supported provider and its endpoint repository' do
      {
        { '_RSPEC_MERGIFY_TEST' => 'true' } =>
          ['rspec_mergify_suite', 'Mergifyio/rspec-mergify'],
        { 'GITHUB_ACTIONS' => 'true', 'GITHUB_REPOSITORY' => 'Mergifyio/x' } =>
          ['github_actions', 'Mergifyio/x'],
        { 'BUILDKITE' => 'true', 'BUILDKITE_REPO' => 'git@github.com:Mergifyio/x.git' } =>
          ['buildkite', 'Mergifyio/x']
      }.each do |env, (provider, repository)|
        ENV.replace(ENV.to_h.merge(env))

        expect(described_class.detect_provider).to eq(provider)
        expect(described_class.detect_repository_name).to eq(repository)

        env.each_key { |k| ENV.delete(k) }
      end
    end

    it 'returns nothing outside CI' do
      expect(described_class.detect_provider).to be_nil
    end

    it 'returns attributes keyed by semconv name' do
      ENV['_RSPEC_MERGIFY_TEST'] = 'true'
      attributes = described_class.detect_attributes

      expect(attributes).to be_a(Hash)
      expect(attributes.keys).to all(be_a(String))
      expect(attributes.values).to all(be_a(String).or(be_a(Integer)))
    end
  end

  describe Mergify::RSpec::Native::Client, if: Mergify::RSpec::Native.available? do
    # WebMock cannot see these requests -- the binding issues them from Rust --
    # so they go to a real loopback server. WebMock's disable_net_connect! is
    # lifted for the same reason.
    around do |example|
      WebMock.allow_net_connect!
      example.run
    ensure
      WebMock.disable_net_connect!
    end

    def client(url)
      described_class.new(url, 'token', 'Mergifyio', 'rspec-mergify', '1.2.3')
    end

    it 'returns the quarantined test names' do
      body = '{"quarantined_tests":[{"test_name":"a_spec.rb[1:1]"},{"test_name":"b_spec.rb[1:2]"}]}'
      with_stub_api(status: 200, body: body) do |url, paths|
        expect(client(url).fetch_quarantine('main')).to eq(['a_spec.rb[1:1]', 'b_spec.rb[1:2]'])
        expect(paths.first).to start_with('/v1/ci/Mergifyio/repositories/rspec-mergify/quarantines')
      end
    end

    # The two endpoints signal "not enabled" differently, and the difference is
    # deliberate upstream: quarantine treats 402 (no subscription) as dormant
    # and a 404 as a genuine failure, while the flaky-detection context does the
    # opposite. Asserting both here so the asymmetry is visible from Ruby.
    it 'returns nil when quarantine is not subscribed' do
      with_stub_api(status: 402, body: '{}') do |url, _paths|
        expect(client(url).fetch_quarantine('main')).to be_nil
      end
    end

    it 'returns nil when flaky detection is not enabled' do
      with_stub_api(status: 404, body: '{}') do |url, _paths|
        expect(client(url).fetch_flaky_context).to be_nil
      end
    end

    it 'raises rather than reporting nothing quarantined' do
      with_stub_api(status: 500, body: '{"message":"boom"}') do |url, _paths|
        expect { client(url).fetch_quarantine('main') }.to raise_error(Mergify::RSpec::Native::ApiError)
      end
    end

    # The seam the adoption commits will use: a verifying double stands in for
    # the client, so specs never need HTTP -- which matters because WebMock
    # cannot intercept requests the binding makes from Rust. pytest-mergify
    # replaces its binding's client object the same way.
    it 'can be stubbed by a verifying double, without any HTTP' do
      fake = instance_double(described_class, fetch_quarantine: ['a_spec.rb[1:1]'],
                                              fetch_flaky_context: nil)

      expect(fake.fetch_quarantine('main')).to eq(['a_spec.rb[1:1]'])
      expect(fake.fetch_flaky_context).to be_nil
    end

    it 'raises ApiError, not a bare StandardError, so degrading can be precise' do
      with_stub_api(status: 500, body: '{}') do |url, _paths|
        expect { client(url).fetch_quarantine('main') }
          .to raise_error(an_instance_of(Mergify::RSpec::Native::ApiError))
      end
    end

    it 'raises when quarantine is missing rather than treating it as dormant' do
      with_stub_api(status: 404, body: '{}') do |url, _paths|
        expect { client(url).fetch_quarantine('main') }.to raise_error(Mergify::RSpec::Native::ApiError, /404/)
      end
    end

    it 'returns the flaky-detection context keyed as the other clients receive it' do
      body = '{"budget_ratio_for_new_tests":0.1,"budget_ratio_for_unhealthy_tests":0.2,' \
             '"existing_test_names":["a"],"existing_tests_mean_duration_ms":12,' \
             '"unhealthy_test_names":["b"],"budget_ratio_for_test_retries":0.3,' \
             '"flaky_test_names":["c"],"broken_test_names":["d"],' \
             '"max_test_execution_count":5,"max_test_name_length":200,' \
             '"min_budget_duration_ms":1000,"min_test_execution_count":2}'
      with_stub_api(status: 200, body: body) do |url, _paths|
        context = client(url).fetch_flaky_context

        expect(context).to eq(
          'budget_ratio_for_new_tests' => 0.1,
          'budget_ratio_for_unhealthy_tests' => 0.2,
          'existing_test_names' => ['a'],
          'existing_tests_mean_duration_ms' => 12,
          'unhealthy_test_names' => ['b'],
          'budget_ratio_for_test_retries' => 0.3,
          'flaky_test_names' => ['c'],
          'broken_test_names' => ['d'],
          'max_test_execution_count' => 5,
          'max_test_name_length' => 200,
          'min_budget_duration_ms' => 1000,
          'min_test_execution_count' => 2
        )
      end
    end
  end

  describe Mergify::RSpec::Native::Budget, if: Mergify::RSpec::Native.available? do
    # The arithmetic is the Rust core's and is unit-tested there; what these
    # pin is the Ruby-facing contract -- that a context Hash goes back in the
    # shape fetch_flaky_context handed out, and that the plan comes back keyed
    # for the caller.
    let(:context) do
      {
        'budget_ratio_for_new_tests' => 0.5,
        'budget_ratio_for_unhealthy_tests' => 0.25,
        'existing_test_names' => ['old_spec.rb[1:1]'],
        'existing_tests_mean_duration_ms' => 100,
        'unhealthy_test_names' => ['flaky_spec.rb[1:1]'],
        'max_test_execution_count' => 5,
        'max_test_name_length' => 200,
        'min_budget_duration_ms' => 1000,
        'min_test_execution_count' => 2
      }
    end

    describe '.should_run' do
      it 'runs in new-test mode only when there is a baseline to compare against' do
        expect(described_class.should_run(context, 'new')).to be(true)
        expect(described_class.should_run(context.merge('existing_test_names' => []), 'new')).to be(false)
      end

      it 'rejects a mode it does not know' do
        expect { described_class.should_run(context, 'sideways') }
          .to raise_error(ArgumentError, /unknown mode/)
      end

      it 'reports a context missing a required key rather than assuming a default' do
        expect { described_class.should_run(context.except('min_budget_duration_ms'), 'new') }
          .to raise_error(KeyError, /min_budget_duration_ms/)
      end

      it 'accepts a context without the optional retry keys' do
        expect(described_class.should_run(context, 'unhealthy')).to be(true)
      end
    end

    describe '.compute' do
      it 'plans only the tests the mode is about, minus the opted out' do
        plan = described_class.compute(
          context, 'new', ['old_spec.rb[1:1]', 'new_spec.rb[1:1]', 'skip_spec.rb[1:1]'], ['skip_spec.rb[1:1]']
        )

        expect(plan['tests_to_process']).to eq(['new_spec.rb[1:1]'])
        expect(plan['available_budget_ms']).to be_a(Float)
      end

      it 'never plans below the floor the context sets' do
        plan = described_class.compute(context, 'new', ['new_spec.rb[1:1]'], [])

        expect(plan['available_budget_ms']).to eq(1000.0)
      end
    end

    describe '.static_share_ms and .dynamic_share_ms' do
      it 'splits the budget evenly up front' do
        expect(described_class.static_share_ms(1000.0, 4)).to eq(250.0)
      end

      it 'redistributes what is left as the session progresses' do
        expect(described_class.dynamic_share_ms(1000.0, 400.0, 4, 2)).to eq(300.0)
      end
    end
  end
end
